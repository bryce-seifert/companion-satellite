import { LoupedeckDevice, LoupedeckButtonId, LoupedeckKnobId } from 'loupedeck'
import sharp = require('sharp')
import { CompanionSatelliteClient } from '../client'
import { CardGenerator } from '../cards'
import { ImageWriteQueue } from '../writeQueue'
import { DeviceDrawProps, DeviceRegisterProps, WrappedDevice } from './api'

interface SideSectionInfo {
	text: string
	bgColor: string
}
interface SideScreenInfo {
	top: SideSectionInfo
	center: SideSectionInfo
	bottom: SideSectionInfo
}
function createEmpty(): SideScreenInfo {
	return {
		top: {
			text: '',
			bgColor: '#000000',
		},
		center: {
			text: '',
			bgColor: '#000000',
		},
		bottom: {
			text: '',
			bgColor: '#000000',
		},
	}
}

export class LoupedeckWrapper implements WrappedDevice {
	readonly #cardGenerator: CardGenerator
	readonly #deck: LoupedeckDevice
	readonly #deviceId: string

	#queueOutputId: number
	#queue: ImageWriteQueue

	#leftInfo = createEmpty()
	#rightInfo = createEmpty()

	public get deviceId(): string {
		return this.#deviceId
	}
	public get productName(): string {
		return `Satellite Loupedeck Live`
	}

	public constructor(deviceId: string, device: LoupedeckDevice, cardGenerator: CardGenerator) {
		this.#deck = device
		this.#deviceId = deviceId
		this.#cardGenerator = cardGenerator

		this.#queueOutputId = 0

		this.#cardGenerator

		const drawSideBox = async (screen: 'left' | 'right', y: number, info: SideSectionInfo) => {
			const textLines = info.text.split('\\n')
			const lineCount = Math.min(textLines.length, 4)
			const textHeight = (lineCount - 1) * 20 + 16

			const r = parseInt(info.bgColor.substr(1, 2), 16)
			const g = parseInt(info.bgColor.substr(3, 2), 16)
			const b = parseInt(info.bgColor.substr(5, 2), 16)
			const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255

			const textColor = luminance > 0.5 ? '#000000' : '#ffffff'

			let svgTextStr = ''
			for (let i = 0; i < lineCount; i++) {
				const text = textLines[i]

				const y = 16 + i * 20 + (90 - textHeight) / 2

				svgTextStr += `<text
                            font-family="'sans-serif'"
                            font-size="16px" 
                            x="30" 
                            y="${y}"
                            fill="${textColor}"
                            text-anchor="middle" 
                            >${text}</text>`
			}

			const img = sharp({
				create: {
					width: 60,
					height: 90,
					channels: 3,
					background: {
						r: 0,
						g: 0,
						b: 0,
					},
				},
			}).composite([
				{
					input: Buffer.from(
						`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 90" version="1.1"> 
						<rect width="60" height="90" style="fill:${info.bgColor}" />
						${svgTextStr}
                    </svg>`
					),
					top: 0,
					left: 0,
				},
			])

			const buffer = await img.removeAlpha().toBuffer()

			await this.#deck.drawBuffer({
				id: screen,
				width: 60,
				height: 90,
				x: 0,
				y: y,
				buffer: buffer,
			})
		}

		this.#queue = new ImageWriteQueue(async (key: number, buffer: Buffer) => {
			if (key === 90) {
				return drawSideBox('left', 0, this.#leftInfo.top)
			} else if (key === 91) {
				return drawSideBox('left', 90, this.#leftInfo.center)
			} else if (key === 92) {
				return drawSideBox('left', 180, this.#leftInfo.bottom)
			} else if (key === 95) {
				return drawSideBox('right', 0, this.#rightInfo.top)
			} else if (key === 96) {
				return drawSideBox('right', 90, this.#rightInfo.center)
			} else if (key === 97) {
				return drawSideBox('right', 180, this.#rightInfo.bottom)
			} else if (key > 40) {
				return
			}

			const outputId = this.#queueOutputId

			const width = 80
			const height = 80

			let newbuffer: Buffer | null = null
			try {
				newbuffer = await sharp(buffer, { raw: { width: 72, height: 72, channels: 3 } })
					.resize(width, height)
					.raw()
					.toBuffer()
			} catch (e) {
				console.log(`device(${deviceId}): scale image failed: ${e}`)
				return
			}

			// Check if generated image is still valid
			if (this.#queueOutputId === outputId) {
				try {
					// Get offset x/y for key index
					const x = (key % 4) * 90
					const y = Math.floor(key / 4) * 90

					await this.#deck.drawBuffer({
						id: 'center',
						width,
						height,
						x: x + (90 - width) / 2,
						y: y + (90 - height) / 2,
						buffer: newbuffer,
					})
				} catch (e_1) {
					console.error(`device(${deviceId}): fillImage failed: ${e_1}`)
				}
			}
		})
	}

	getRegisterProps(): DeviceRegisterProps {
		return {
			keysTotal: 32,
			keysPerRow: 8,
			bitmaps: true,
			colours: true,
			text: true,
		}
	}

	async close(): Promise<void> {
		this.#queue?.abort()
		this.#deck.close()
	}
	async initDevice(client: CompanionSatelliteClient, status: string): Promise<void> {
		const convertButtonId = (id: LoupedeckButtonId | LoupedeckKnobId): number => {
			if (!isNaN(Number(id))) {
				return 24 + Number(id)
			} else if (id === 'circle') {
				return 24
			} else if (id === 'knobTL') {
				return 1
			} else if (id === 'knobCL') {
				return 9
			} else if (id === 'knobBL') {
				return 17
			} else if (id === 'knobTR') {
				return 6
			} else if (id === 'knobCR') {
				return 14
			} else if (id === 'knobBR') {
				return 22
			} else {
				// Discard
				return 99
			}
		}
		console.log('Registering key events for ' + this.deviceId)
		this.#deck.on('down', ({ id }) => client.keyDown(this.deviceId, convertButtonId(id)))
		this.#deck.on('up', ({ id }) => client.keyUp(this.deviceId, convertButtonId(id)))
		this.#deck.on('rotate', ({ id, delta }) => {
			let id2
			if (id === 'knobTL') {
				id2 = 0
			} else if (id === 'knobCL') {
				id2 = 8
			} else if (id === 'knobBL') {
				id2 = 16
			} else if (id === 'knobTR') {
				id2 = 7
			} else if (id === 'knobCR') {
				id2 = 15
			} else if (id === 'knobBR') {
				id2 = 23
			}

			if (id2 !== undefined) {
				switch (delta) {
					case -1:
						client.keyUp(this.deviceId, id2)
						break
					case 1:
						client.keyDown(this.deviceId, id2)
						break
				}
			}
		})
		const translateKeyIndex = (key: number): number => {
			const x = key % 4
			const y = Math.floor(key / 4)
			return y * 8 + x + 2
		}
		this.#deck.on('touchstart', (data) => {
			for (const touch of data.changedTouches) {
				if (touch.target.key !== undefined) {
					client.keyDown(this.deviceId, translateKeyIndex(touch.target.key))
				}
			}
		})
		this.#deck.on('touchend', (data) => {
			for (const touch of data.changedTouches) {
				if (touch.target.key !== undefined) {
					client.keyUp(this.deviceId, translateKeyIndex(touch.target.key))
				}
			}
		})

		// Start with blanking it
		await this.blankDevice()

		await this.showStatus(client.host, status)
	}

	async deviceAdded(): Promise<void> {
		this.#queueOutputId++
	}
	async setBrightness(percent: number): Promise<void> {
		this.#deck.setBrightness(percent / 100)
	}
	async blankDevice(): Promise<void> {
		for (let i = 0; i < 8; i++) {
			this.#deck.setButtonColor({
				id: i === 0 ? 'circle' : ((i + '') as any),
				color: '#0000',
			})
		}

		// await this.#deck.clearPanel()
	}
	async draw(d: DeviceDrawProps): Promise<void> {
		if (d.keyIndex >= 24 && d.keyIndex < 32) {
			const index = d.keyIndex - 24
			const color = d.color || '#000000'
			this.#deck.setButtonColor({
				id: index === 0 ? 'circle' : ((index + '') as any),
				color,
			})
			return
		}
		const x = (d.keyIndex % 8) - 2
		const y = Math.floor(d.keyIndex / 8)

		if (x >= 0 && x < 4) {
			const keyIndex = x + y * 4
			if (d.image) {
				this.#queue.queue(keyIndex, d.image)
			} else {
				throw new Error(`Cannot draw for Loupedeck without image`)
			}
		}

		let index: number | undefined
		let obj: SideSectionInfo | undefined
		if (d.keyIndex === 1) {
			index = 90
			obj = this.#leftInfo.top
		} else if (d.keyIndex === 9) {
			index = 91
			obj = this.#leftInfo.center
		} else if (d.keyIndex === 17) {
			index = 92
			obj = this.#leftInfo.bottom
		} else if (d.keyIndex === 6) {
			index = 95
			obj = this.#rightInfo.top
		} else if (d.keyIndex === 14) {
			index = 96
			obj = this.#rightInfo.center
		} else if (d.keyIndex === 22) {
			index = 97
			obj = this.#rightInfo.bottom
		}

		if (obj) {
			obj.text = d.text || ''
			obj.bgColor = d.color || '#000000'
		}

		if (index) {
			this.#queue.queue(index, Buffer.alloc(0))
		}
	}
	async showStatus(hostname: string, status: string): Promise<void> {
		// abort and discard current operations
		this.#queue?.abort()
		this.#queueOutputId++
		const outputId = this.#queueOutputId
		this.#cardGenerator
			.generateBasicCard(360, 270, hostname, status)
			.then(async (buffer) => {
				if (outputId === this.#queueOutputId) {
					// still valid
					this.#deck.drawBuffer({
						id: 'center',
						buffer,
					})
				}
			})
			.catch((e) => {
				console.error(`Failed to fill device`, e)
			})
	}
}

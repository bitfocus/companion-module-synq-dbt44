const NUM_INPUTS = 8
const NUM_OUTPUTS = 8

module.exports = function (self) {
	const presets = {}
	const instanceId = self.id || 'instance'
	for (let outNum = 1; outNum <= NUM_OUTPUTS; outNum++) {
		const category = `Out ${outNum}`
		for (let inNum = 1; inNum <= NUM_INPUTS; inNum++) {
			const id = `matrix_mute_in${inNum}_out${outNum}`
			const varId = `gain_input_${inNum}_${outNum}`
			presets[id] = {
				type: 'button',
				category,
				name: `In ${inNum}`,
				style: {
					text: `In ${inNum}\n$(${instanceId}:${varId})`,
					size: '18',
					color: 0xffffff,
					bgcolor: 0x000000,
				},
				feedbacks: [
					{
						feedbackId: 'matrix_point_muted',
						options: { input: inNum, output: outNum },
						style: {
							bgcolor: 0xff0000,
							text: `In ${inNum}\nMUTE`,
							color: 0xffffff,
						},
					},
				],
				steps: [
					{
						down: [
							{
								actionId: 'matrix_point_mute_toggle',
								options: { input: inNum, output: outNum },
							},
						],
						up: [],
					},
				],
			}
		}
	}
	self.setPresetDefinitions(presets)
}

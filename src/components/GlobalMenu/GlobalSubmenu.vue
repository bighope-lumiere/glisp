<template>
	<div class="GlobalSubmenu">
		<div
			class="GlobalSubmenu__item"
			v-for="[label, command] in menu"
			@click="$emit('click', command)"
			:key="label"
		>
			{{ label }}
		</div>
	</div>
</template>

<script lang="ts">
import {defineComponent, PropType} from '@vue/composition-api'

export default defineComponent({
	name: 'GlobalSubmenu',
	props: {
		menu: {
			required: true,
			type: Array as PropType<[string, string][]>,
		},
	},
})
</script>

<style lang="stylus" scoped>
.GlobalSubmenu
	position relative
	border 1px solid var(--border)
	border-radius 0.3rem
	background var(--opaque)
	white-space nowrap
	user-select none
	z-index 100

	&__item
		padding 0 1rem
		height 3.2rem
		border-bottom 1px dotted var(--border)
		color var(--comment)
		// background red
		line-height 3.2rem
		cursor pointer

		&:hover
			color var(--hover)

		&:last-child
			border none
</style>

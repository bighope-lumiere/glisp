/* eslint-ignore @typescript-eslint/no-use-before-define */
import {vec2} from 'gl-matrix'
import Bezier from 'bezier-js'
import {
	MalVal,
	keywordFor as K,
	isKeyword,
	MalNamespace,
	LispError,
	isSymbol,
	MalVector
} from '../types'
import {partition} from '../utils'

type PathType = (string | number)[]
type SegmentType = [string, ...number[]]

const EPSILON = 1e-5

const K_PATH = K('path')
const K_M = K('M')
const K_L = K('L')
const K_C = K('C')
const K_Z = K('Z')

const SIN_Q = [0, 1, 0, -1]
const COS_Q = [1, 0, -1, 0]
const TWO_PI = Math.PI * 2
const HALF_PI = Math.PI / 2
const KAPPA = (4 * (Math.sqrt(2) - 1)) / 3
const UNIT_QUAD_BEZIER = new Bezier([
	{x: 1, y: 0},
	{x: 1, y: KAPPA},
	{x: KAPPA, y: 1},
	{x: 0, y: 1}
])

const unsignedMod = (x: number, y: number) => ((x % y) + y) % y

const clamp = (value: number, min: number, max: number) =>
	Math.max(min, Math.min(max, value))

function getBezier(points: number[]) {
	const coords = partition(2, points).map(([x, y]) => ({x, y}))
	if (coords.length !== 4) {
		throw new LispError('Invalid point count for cubic bezier')
	}
	return new Bezier(coords)
}

export function* iterateSegment(path: PathType): Generator<SegmentType> {
	if (!Array.isArray(path)) {
		throw new LispError('Invalid path')
	}

	let start = path[0] === K_PATH ? 1 : 0

	for (let i = start + 1, l = path.length; i <= l; i++) {
		if (i === l || isKeyword(path[i])) {
			yield MalVector.from(path.slice(start, i)) as SegmentType
			start = i
		}
	}
}

/**
 *  Yields a segment with its complete points.
 *  Thus each object can be like,
 * [L prevX prevY x y]
 * [Q prevX prevY x1 y1 x2 y2 x3 y3]
 * [Z x y firstX firstY]
 */
export function* iterateCurve(path: PathType): Generator<SegmentType> {
	let first: number[] = [],
		prev: number[] = []

	for (const [cmd, ...points] of iterateSegment(path)) {
		switch (cmd) {
			case K_M:
				yield [cmd, ...points]
				first = points
				prev = first
				break
			case K_L:
			case K_C:
				yield [cmd, ...prev, ...points] as SegmentType
				prev = points.slice(-2)
				break
			case K_Z:
				yield [cmd, ...prev, ...first] as SegmentType
				break
		}
	}
}

function* iterateCurveWithLength(
	path: PathType
): Generator<[SegmentType, number]> {
	let length = 0

	for (const seg of iterateCurve(path)) {
		const [cmd, ...points] = seg
		switch (cmd) {
			case K_Z:
			case K_L:
				length += vec2.dist(
					points.slice(0, 2) as vec2,
					points.slice(-2) as vec2
				)
				break
			case K_C: {
				const bezier = getBezier(points)
				length += bezier.length()
				break
			}
		}
		yield [seg, length]
	}
}

function closedQ(path: PathType) {
	return path.slice(-1)[0] === K_Z
}

function findCurveAtLength(len: number, path: PathType): [SegmentType, number] {
	const segs = iterateCurveWithLength(path)

	len = Math.max(len, 0)

	let startLen = 0
	let lastSeg = null

	for (const [seg, endLen] of segs) {
		const [cmd, ...points] = seg
		// Skip zero-length segment
		if (cmd === K_M) {
			continue
		} else if (
			cmd === K_Z &&
			vec2.dist(points.slice(0, 2) as vec2, points.slice(-2) as vec2) < EPSILON
		) {
			continue
		}

		if (len <= endLen) {
			const t = (len - startLen) / (endLen - startLen)
			return [seg, t]
		}
		startLen = endLen
		lastSeg = seg
	}

	if (lastSeg) {
		return [lastSeg, 1]
	} else {
		throw new LispError('[js: findCurveAtLength] Empty path')
	}
}

/**
 * Returns:
 * A --- B----
 *        \  <- this angle
 *         \
 *          C
 * The returned value is signed and is positive angle if ABC is CW, else negative.
 */
function getTurnAngle(from: vec2, through: vec2, to: vec2): number {
	const AB = vec2.create()
	const BC = vec2.create()

	vec2.sub(AB, through, from)
	vec2.sub(BC, to, through)

	const angle = vec2.angle(AB, BC)

	// Rotate AB 90 degrees in CW
	vec2.rotate(AB, AB, [0, 0], HALF_PI)
	const rot = Math.sign(vec2.dot(AB, BC))

	return angle * rot
}

/**
 * Returns +1 if the path is clock-wise and -1 when CCW.
 * Returns 0 if the direction is indeterminate
 * like when the path is opened or 8-shaped.
 */
function getPathRotation(path: PathType): number {
	// Indeterminate case: the path is opened
	if (!closedQ(path)) {
		return 0
	}

	const segments = Array.from(iterateSegment(path))

	// Remove the last (Z)
	segments.pop()

	// Indeterminate case: the vertex of the path is < 3
	if (segments.length < 3) {
		return 0
	}

	// Extract only vertex points
	const points = segments.map(seg => seg.slice(-2)) as number[][]
	const numpt = points.length

	let rot = 0

	for (let i = 0; i < numpt; i++) {
		const last = points[(i - 1 + numpt) % numpt]
		const curt = points[i]
		const next = points[(i + 1) % numpt]

		rot += getTurnAngle(last as vec2, curt as vec2, next as vec2)
	}

	return Math.sign(Math.round(rot))
}

function toBeziers(path: PathType) {
	const ret: PathType = [K_PATH]

	for (const line of iterateSegment(path)) {
		const [cmd, ...args] = line

		let sx = 0,
			sy = 0

		switch (cmd) {
			case K_M:
			case K_C:
				;[sx, sy] = args
				ret.push(...line)
				break
			case K_Z:
				ret.push(...line)
				break
			case K_L:
				ret.push(K_L, sx, sy, ...args, ...args)
				break
			default:
				throw new Error(
					`Invalid d-path command: ${isSymbol(cmd) ? cmd.slice(1) : cmd}`
				)
		}
	}
	return ret
}

function pathLength(path: PathType) {
	const segs = Array.from(iterateCurveWithLength(path))
	return segs[segs.length - 1][1]
}

type LengthFunctionType = (len: number, path: PathType) => MalVal

function convertToNormalizedLengthFunction(f: LengthFunctionType) {
	return (t: number, path: PathType) => f(t * pathLength(path), path)
}

function makeOpen(path: PathType) {
	if (closedQ(path)) {
		path = path.slice(0, path.length - 1)

		const first = path[0] === K_PATH ? path.slice(2, 4) : path.slice(1, 3)
		const last = path.slice(-2)

		// Add L command to connect to first points if the last Z has certain length
		if (vec2.dist(first as vec2, last as vec2) > EPSILON) {
			path.push(K_L, ...first)
		}
	}

	return path
}

function pathJoin(first: PathType, ...rest: PathType[]) {
	const ret = makeOpen(first)

	const lastEnd = vec2.fromValues(...(ret.slice(-2) as [number, number]))
	const start = vec2.create()

	for (const path of rest) {
		let opened = makeOpen(path).slice(1) // remove K_PATH
		vec2.copy(start, opened.slice(1, 3) as vec2) // retrieve M x y

		if (vec2.dist(lastEnd, start) < EPSILON) {
			opened = opened.slice(3) // Remove M if both ends are ident
		} else {
			opened[0] = K_L
		}

		ret.push(...opened)
		vec2.copy(lastEnd, opened.slice(-2) as vec2)
	}

	return ret
}

function positionAtLength(len: number, path: PathType) {
	const [[cmd, ...points], t] = findCurveAtLength(len, path)

	switch (cmd) {
		case K_L:
		case K_Z: {
			// const first =
			const pos = vec2.lerp(
				vec2.create(),
				points.slice(0, 2) as vec2,
				points.slice(-2) as vec2,
				t
			)
			return pos
		}
		case K_C: {
			const bezier = getBezier(points)
			const {x, y} = bezier.get(t)
			return [x, y]
		}
	}

	throw new LispError(`[path/position-at-length] Don't know why this error...`)
}

function normalAtLength(len: number, path: PathType) {
	const [[cmd, ...points], t] = findCurveAtLength(len, path)

	// Invert normal if the path is clockwise
	const mul = getPathRotation(path) === 1 ? -1 : 1

	switch (cmd) {
		case K_L:
		case K_Z: {
			const dir = vec2.sub(
				vec2.create(),
				points.slice(-2) as vec2,
				points.slice(0, 2) as vec2
			)
			vec2.normalize(dir, dir)
			vec2.rotate(dir, dir, [0, 0], HALF_PI * mul)
			return dir
		}
		case K_C: {
			const bezier = getBezier(points)
			const {x, y} = bezier.normal(t)
			return [x * mul, y * mul]
		}
	}

	throw new LispError(`[path/normal-at-length] Don't know why this error...`)
}

function angleAtLength(len: number, path: PathType) {
	const [[cmd, ...points], t] = findCurveAtLength(len, path)

	let dir: vec2 | null = null

	switch (cmd) {
		case K_L:
		case K_Z: {
			dir = vec2.sub(
				vec2.create(),
				points.slice(-2) as vec2,
				points.slice(0, 2) as vec2
			)
			vec2.normalize(dir, dir)
			break
		}
		case K_C: {
			const bezier = getBezier(points)
			const {x, y} = bezier.normal(t)
			dir = vec2.fromValues(x, y)
			vec2.rotate(dir, dir, [0, 0], -HALF_PI)
			break
		}
	}

	if (dir) {
		return Math.atan2(dir[1], dir[0])
	}

	throw new LispError(`[path/normal-at-length] Don't know why this error...`)
}

function arc([x, y]: vec2, r: number, start: number, end: number): MalVal[] {
	const min = Math.min(start, end)
	const max = Math.max(start, end)

	let points: number[][] = [[x + r * Math.cos(min), y + r * Math.sin(min)]]

	const minSeg = Math.ceil(min / HALF_PI - EPSILON)
	const maxSeg = Math.floor(max / HALF_PI + EPSILON)

	// For trim
	const t1 = unsignedMod(min / HALF_PI, 1)
	const t2 = unsignedMod(max / HALF_PI, 1)

	// quadrant
	//  2 | 3
	// ---+---
	//  1 | 0
	if (minSeg > maxSeg) {
		// Less than 90 degree
		const bezier = UNIT_QUAD_BEZIER.split(t1, t2)
		const q = unsignedMod(Math.floor(min / HALF_PI), 4),
			sin = SIN_Q[q],
			cos = COS_Q[q]

		points.push(
			...bezier.points
				.slice(1)
				.map(p => [
					x + r * (p.x * cos - p.y * sin),
					y + r * (p.x * sin + p.y * cos)
				])
		)
	} else {
		// More than 90 degree

		// Add beginning segment
		if (Math.abs(minSeg * HALF_PI - min) > EPSILON) {
			const bezier = UNIT_QUAD_BEZIER.split(t1, 1)
			const q = unsignedMod(minSeg - 1, 4),
				sin = SIN_Q[q],
				cos = COS_Q[q]

			points.push(
				...bezier.points
					.slice(1)
					.map(p => [
						x + r * (p.x * cos - p.y * sin),
						y + r * (p.x * sin + p.y * cos)
					])
			)
		}

		// Cubic bezier points of the quarter circle in quadrant 0 in position [0, 0]
		const qpoints: number[][] = [
			[r, KAPPA * r],
			[KAPPA * r, r],
			[0, r]
		]

		// Add arc by every quadrant
		for (let seg = minSeg; seg < maxSeg; seg++) {
			const q = unsignedMod(seg, 4),
				sin = SIN_Q[q],
				cos = COS_Q[q]
			points.push(
				...qpoints.map(([px, py]) => [
					x + px * cos - py * sin,
					y + px * sin + py * cos
				])
			)
		}

		// Add terminal segment
		if (Math.abs(maxSeg * HALF_PI - max) > EPSILON) {
			const bezier = UNIT_QUAD_BEZIER.split(0, t2)
			const q = unsignedMod(maxSeg, 4),
				sin = SIN_Q[q],
				cos = COS_Q[q]

			points.push(
				...bezier.points
					.slice(1)
					.map(p => [
						x + r * (p.x * cos - p.y * sin),
						y + r * (p.x * sin + p.y * cos)
					])
			)
		}
	}

	if (end < start) {
		points = points.reverse()
	}

	return MalVector.from([
		K_PATH,
		K_M,
		...points[0],
		...partition(3, points.slice(1))
			.map(pts => [K_C, ...pts.flat()])
			.flat()
	])
}

function offsetSegmentBezier(...args: number[]) {
	const bezier = getBezier(args.slice(0, 8))

	if (bezier.length() < EPSILON) {
		return false
	}

	const d = args[8]

	const offset = bezier.offset(d)

	const {x, y} = offset[0].points[0]

	const ret = [K_M, x, y]

	for (const seg of offset) {
		const pts = seg.points
		ret.push(K_C)
		for (let i = 1; i < 4; i++) {
			ret.push(pts[i].x, pts[i].y)
		}
	}

	return ret
}

function offsetSegmentLine(a: vec2, b: vec2, d: number) {
	if (vec2.equals(a, b)) {
		return false
	}

	const dir = vec2.create()

	vec2.sub(dir, b, a)
	vec2.rotate(dir, dir, [0, 0], Math.PI / 2)
	vec2.normalize(dir, dir)
	vec2.scale(dir, dir, d)

	const oa = vec2.create()
	const ob = vec2.create()

	vec2.add(oa, a, dir)
	vec2.add(ob, b, dir)

	return [K_M, ...oa, K_L, ...ob] as PathType
}

function offset(d: number, path: PathType) {
	const dirLast = vec2.create()
	const dirNext = vec2.create()

	const isClockwise = getPathRotation(path) === 1

	if (isClockwise) {
		d *= -1
	}

	const makeRoundCorner = (origin: vec2, last: vec2, next: vec2) => {
		// dont know why this order
		vec2.sub(dirLast, last, origin)
		vec2.sub(dirNext, next, origin)

		if (d < 0) {
			vec2.scale(dirLast, dirLast, -1)
			vec2.scale(dirNext, dirNext, -1)
		}

		const angle = vec2.angle(dirLast, dirNext)

		const start = Math.atan2(dirLast[1], dirLast[0])

		// Determine turned left or right
		vec2.rotate(dirLast, dirLast, [0, 0], HALF_PI)
		const turn = Math.sign(vec2.dot(dirLast, dirNext))

		const end = start + angle * turn

		return arc(origin, d, start, end).slice(1) as PathType
	}

	if (!Array.isArray(path) || path[0] !== K_PATH) {
		throw new Error('Invalid path')
	} else {
		const ret: PathType = [K_PATH]
		const commands = path.slice(1)

		//       loff   coff
		//----------|  /\
		//          | /  \
		//----------|/    \
		//      lorig\     \
		//            \     \

		const lorig = vec2.create() // original last
		const forig = vec2.create() // original first
		const loff = vec2.create() // last offset
		const coff = vec2.create() // current offset
		const foff = vec2.create() // first offset

		let continued = false

		let cmd, points
		for ([cmd, ...points] of iterateSegment(commands)) {
			if (cmd === K_M) {
				vec2.copy(forig, points as vec2)
				vec2.copy(lorig, forig)
			} else if (cmd === K_L || cmd === K_C || cmd === K_Z) {
				if (cmd === K_Z) {
					points = forig as number[]
				}

				let off =
					cmd === K_C
						? offsetSegmentBezier(...lorig, ...(points as number[]), d)
						: offsetSegmentLine(lorig, points as vec2, d)
				if (off) {
					vec2.copy(coff, off.slice(1, 3) as vec2)

					if (continued) {
						if (vec2.equals(loff, off.slice(1) as vec2)) {
							off = off.slice(3) // remove (M 0 1)
						} else {
							// make a bevel
							const corner = makeRoundCorner(lorig, loff, coff)
							// (M x y # ...) + (M x y # ...)
							off = [...corner.slice(3), ...off.slice(3)]
							// make a chamfer Bevel
							// off[0] = K('L')
						}
					} else {
						// First time to offset
						continued = true
						vec2.copy(foff, off.slice(1, 3) as vec2)
					}
					ret.push(...off)
					vec2.copy(lorig, points.slice(-2) as vec2)
					vec2.copy(loff, off.slice(-2) as vec2)
				}
			}

			if (cmd === K_Z) {
				// Make a bevel corner
				const corner = makeRoundCorner(lorig, loff, foff)
				ret.push(...corner.slice(3), K_Z)
				// Chanfer
				// ret.push(K_Z)

				continued = false
			}
		}
		return MalVector.from(ret)
	}
}

function trimCurve(start: number, end: number, curve: SegmentType) {
	if (start < EPSILON && 1 - EPSILON < end) {
		return curve
	}

	const [cmd, ...points] = curve
	let trimmed: number[] = []

	switch (cmd) {
		case K_L:
		case K_Z: {
			const p0 = points.slice(0, 2) as vec2
			const p1 = points.slice(-2) as vec2
			const np0 = vec2.lerp(vec2.create(), p0, p1, start)
			const np1 = vec2.lerp(vec2.create(), p0, p1, end)
			trimmed = [...np0, ...np1]
			break
		}
		case K_C: {
			const bezier = getBezier(points).split(start, end)
			trimmed = bezier.points.map(({x, y}) => [x, y]).flat()
			break
		}
		default:
			throw new LispError('[js: trimCurve] Only can trim L or C')
	}

	return MalVector.from([cmd, ...trimmed])
}

/**
 * Trim path by relative length from each ends
 */
function trimByLength(start: number, end: number, path: PathType) {
	// In case no change
	if (start < EPSILON && end < EPSILON) {
		console.log('no change')
		return path
	}

	path = makeOpen(path)

	const curves = Array.from(iterateCurveWithLength(path))
	const lastCurve = curves[curves.length - 1]

	// Convert end parameter to a distance from the beginning of path
	const length = lastCurve[1]
	end = length - end

	// Make positiove
	start = Math.max(0, start)
	end = Math.max(0, end)

	// Swap to make sure start < end
	if (start > end) {
		;[start, end] = [end, start]
	}

	// Returns empty if trimmed entire
	if (end - start < EPSILON) {
		return [K_PATH]
	}

	let startIndex = null,
		startT = NaN,
		endIndex = null,
		endT = NaN

	let fromLen = 0

	// NOTE: might be better to search from both ends to avoid the overhead
	for (let i = 0; i < curves.length; i++) {
		const [[cmd, ...points], toLen] = curves[i] // Skip zero-length segment
		if (
			cmd === K_M ||
			(cmd === K_Z &&
				vec2.dist(points.slice(0, 2) as vec2, points.slice(-2) as vec2) <
					EPSILON)
		) {
			continue
		}

		if (fromLen <= start && start < toLen) {
			startIndex = i
			startT = (start - fromLen) / (toLen - fromLen)
		}

		if (fromLen <= end && end < toLen) {
			endIndex = i
			endT = (end - fromLen) / (toLen - fromLen)
		}

		if (startIndex !== null && endIndex !== null) {
			break
		}

		fromLen = toLen
	}

	if (startIndex === null) {
		startIndex = curves.length - 1
		startT = 1
	}

	if (endIndex === null) {
		endIndex = curves.length - 1
		endT = 1
	}

	const trimmed: SegmentType[] = []

	if (startIndex === endIndex) {
		// Trim one curve on both its start and end
		const seg = curves[startIndex][0]
		trimmed.push(trimCurve(startT, endT, seg) as SegmentType)
	} else {
		// Trim over multiple curves
		const startSeg = curves[startIndex][0]
		trimmed.push(trimCurve(startT, 1, startSeg) as SegmentType)

		const middleCurves = curves
			.slice(startIndex + 1, endIndex)
			.map(([c, _]) => c)
		trimmed.push(...middleCurves)

		if (endT > EPSILON) {
			const endSeg = curves[endIndex][0]
			trimmed.push(trimCurve(0, endT, endSeg) as SegmentType)
		}
	}

	// Convert to path
	const rest = trimmed
		.map(([cmd, ...pts], i) => {
			const ret = [cmd, ...pts.slice(2)]
			if (i === 0) {
				ret.unshift(K_M, ...pts.slice(0, 2))
			}
			return ret
		})
		.flat()

	return MalVector.from([K_PATH, ...rest])
}

/**
 * Trim path by normalized T
 */
function pathTrim(t1: number, t2: number, path: PathType) {
	const length = pathLength(path)
	const start = t1 * length,
		end = (1 - t2) * length
	return trimByLength(start, end, path)
}

const jsObjects = new Map<string, any>([
	['arc', arc],
	['path/join', pathJoin],
	['path/to-beziers', toBeziers],
	['path/offset', offset],
	['path/length', pathLength],
	['path/closed?', closedQ],
	['path/position-at-length', positionAtLength],
	['path/position-at', convertToNormalizedLengthFunction(positionAtLength)],
	['path/normal-at-length', normalAtLength],
	['path/normal-at', convertToNormalizedLengthFunction(normalAtLength)],
	['path/angle-at-length', angleAtLength],
	['path/angle-at', convertToNormalizedLengthFunction(angleAtLength)],
	['path/trim-by-length', trimByLength],
	['path/trim', pathTrim],
	[
		'path/split-segments',
		([_, ...path]: PathType) => MalVector.from(iterateSegment(path))
	]
])

export default {
	jsObjects
} as MalNamespace
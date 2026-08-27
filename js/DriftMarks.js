import * as THREE from 'three';

const MAX_SEGMENTS = 4096;
const VERTS_PER_SEGMENT = 6;
const FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * 3;
const COLOR_FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * 4;

const WIDTH = 0.08;
const Y_OFFSET = 0.05;
const MIN_SEGMENT_LENGTH = 0.02;
const INTENSITY_MIN = 0.5;
const INTENSITY_MAX = 2.0;
const INV_INTENSITY_RANGE = 1 / ( INTENSITY_MAX - INTENSITY_MIN );

const STORAGE_PREFIX = 'racing.driftMarks.';
const STORAGE_VERSION = 1;
const QUANTIZE = 1000;

const _wheelWorld = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _pL = new THREE.Vector3();
const _pR = new THREE.Vector3();
const _cL = new THREE.Vector3();
const _cR = new THREE.Vector3();
const _replayPrev = new THREE.Vector3();
const _replayCurr = new THREE.Vector3();
const _containerWorldPos = new THREE.Vector3();

class DriftTrail {

	constructor( scene, material, scale = 1 ) {

		this.scale = scale;

		const positions = new Float32Array( MAX_SEGMENTS * FLOATS_PER_SEGMENT );
		const colors = new Float32Array( MAX_SEGMENTS * COLOR_FLOATS_PER_SEGMENT );

		// Pre-fill RGB to 1; only per-segment alpha is written at runtime.
		for ( let i = 0; i < MAX_SEGMENTS * VERTS_PER_SEGMENT; i ++ ) {

			const o = i * 4;
			colors[ o ] = 1;
			colors[ o + 1 ] = 1;
			colors[ o + 2 ] = 1;

		}

		const geometry = new THREE.BufferGeometry();

		const posAttr = new THREE.BufferAttribute( positions, 3 );
		posAttr.setUsage( THREE.DynamicDrawUsage );
		geometry.setAttribute( 'position', posAttr );

		const colorAttr = new THREE.BufferAttribute( colors, 4 );
		colorAttr.setUsage( THREE.DynamicDrawUsage );
		geometry.setAttribute( 'color', colorAttr );

		geometry.setDrawRange( 0, 0 );

		this.mesh = new THREE.Mesh( geometry, material );
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = - 1;
		scene.add( this.mesh );

		this.positions = positions;
		this.colors = colors;
		this.geometry = geometry;
		this.segmentIndex = 0;
		this.drawCount = 0;
		this.prev = new THREE.Vector3();
		this.active = false;
		this.dirty = false;

		// Per-segment fade bookkeeping (see DriftMarks' own `lifetime`
		// comment) — baseAlphas holds the intensity-derived alpha each
		// segment was WRITTEN with (never itself modified after writing),
		// while the live color buffer's alpha is continuously multiplied
		// down from that base as the segment ages. writeClocks holds the
		// DriftMarks-level clock value (see `clock` below) each segment
		// was written at, so age = clock - writeClocks[slot].
		this.baseAlphas = new Float32Array( MAX_SEGMENTS );
		this.writeClocks = new Float32Array( MAX_SEGMENTS );

	}

	track( wheel, groundY, intensity, emit, clock ) {

		if ( ! wheel ) return;

		wheel.getWorldPosition( _wheelWorld );
		_wheelWorld.y = groundY;

		if ( emit && this.active ) {

			const alpha = THREE.MathUtils.clamp( ( intensity - INTENSITY_MIN ) * INV_INTENSITY_RANGE, 0, 1 );
			this._writeSegment( this.prev, _wheelWorld, alpha, true, clock );

		}

		this.prev.copy( _wheelWorld );
		this.active = emit;

	}

	_writeSegment( prev, curr, alpha, markDirty, clock = 0 ) {

		_dir.subVectors( curr, prev );
		_dir.y = 0;
		const len = _dir.length();
		// WIDTH/MIN_SEGMENT_LENGTH are real-world meters (tuned for NORMAL
		// mode's 1:1 scale). Scaled here by the same factor the AR floating
		// track/arena shrink everything else by (this.scale, passed down
		// from DriftMarks — see the identical need in Particles.js), so a
		// segment threshold tuned for a real car doesn't silently swallow
		// nearly every AR-scale movement (a real 2cm minimum segment length
		// is enormous once car positions themselves are shrunk to
		// millimeters — this was why drift marks never appeared at all in
		// AR: almost no per-frame movement ever cleared the un-scaled
		// threshold).
		if ( len < MIN_SEGMENT_LENGTH * this.scale ) return;
		_dir.divideScalar( len );

		_side.set( _dir.z, 0, - _dir.x ).multiplyScalar( WIDTH * this.scale );

		_pL.copy( prev ).add( _side );
		_pR.copy( prev ).sub( _side );
		_cL.copy( curr ).add( _side );
		_cR.copy( curr ).sub( _side );

		const segIndex = this.segmentIndex; // capture before it advances below
		const offset = segIndex * FLOATS_PER_SEGMENT;
		const p = this.positions;

		// Winding CCW from above so DoubleSide isn't strictly required.
		p[ offset +  0 ] = _pL.x; p[ offset +  1 ] = _pL.y; p[ offset +  2 ] = _pL.z;
		p[ offset +  3 ] = _pR.x; p[ offset +  4 ] = _pR.y; p[ offset +  5 ] = _pR.z;
		p[ offset +  6 ] = _cL.x; p[ offset +  7 ] = _cL.y; p[ offset +  8 ] = _cL.z;
		p[ offset +  9 ] = _pR.x; p[ offset + 10 ] = _pR.y; p[ offset + 11 ] = _pR.z;
		p[ offset + 12 ] = _cR.x; p[ offset + 13 ] = _cR.y; p[ offset + 14 ] = _cR.z;
		p[ offset + 15 ] = _cL.x; p[ offset + 16 ] = _cL.y; p[ offset + 17 ] = _cL.z;

		const colorOffset = segIndex * COLOR_FLOATS_PER_SEGMENT;
		const c = this.colors;

		for ( let i = 0; i < VERTS_PER_SEGMENT; i ++ ) {

			c[ colorOffset + i * 4 + 3 ] = alpha;

		}

		this.baseAlphas[ segIndex ] = alpha;
		this.writeClocks[ segIndex ] = clock;

		if ( markDirty ) {

			const posAttr = this.geometry.attributes.position;
			posAttr.addUpdateRange( offset, FLOATS_PER_SEGMENT );
			posAttr.needsUpdate = true;

			const colAttr = this.geometry.attributes.color;
			colAttr.addUpdateRange( colorOffset, COLOR_FLOATS_PER_SEGMENT );
			colAttr.needsUpdate = true;

			this.dirty = true;

		}

		this.segmentIndex = ( this.segmentIndex + 1 ) % MAX_SEGMENTS;

		if ( this.drawCount < MAX_SEGMENTS * VERTS_PER_SEGMENT ) {

			this.drawCount += VERTS_PER_SEGMENT;
			this.geometry.setDrawRange( 0, this.drawCount );

		}

	}

	// Fades every already-written segment toward invisible as it ages,
	// instead of marks staying on the ground forever (the previous
	// behavior — segments only ever disappeared once the 4096-segment
	// ring buffer wrapped back around and overwrote them, which in
	// practice could take a very long time). Called once per
	// DriftMarks.update() frame, regardless of whether the car is
	// currently drifting, so old marks keep fading even after the car
	// stops. A no-op (skipped entirely by the caller) when lifetime is
	// Infinity, which keeps NORMAL/web mode's permanent, localStorage-
	// persisted marks completely unaffected.
	updateFade( clock, lifetime ) {

		const segCount = this.drawCount / VERTS_PER_SEGMENT;
		if ( segCount === 0 ) return;

		const start = ( segCount < MAX_SEGMENTS ) ? 0 : this.segmentIndex;
		const c = this.colors;

		for ( let i = 0; i < segCount; i ++ ) {

			const slot = ( start + i ) % MAX_SEGMENTS;
			const age = clock - this.writeClocks[ slot ];
			const fade = THREE.MathUtils.clamp( 1 - age / lifetime, 0, 1 );
			const targetAlpha = this.baseAlphas[ slot ] * fade;

			const colorOffset = slot * COLOR_FLOATS_PER_SEGMENT;
			for ( let v = 0; v < VERTS_PER_SEGMENT; v ++ ) c[ colorOffset + v * 4 + 3 ] = targetAlpha;

		}

		this.geometry.attributes.color.needsUpdate = true;
		this.dirty = true;

	}

	serialize() {

		const segCount = this.drawCount / VERTS_PER_SEGMENT;
		if ( segCount === 0 ) return [];

		const start = ( segCount < MAX_SEGMENTS ) ? 0 : this.segmentIndex;
		const p = this.positions;
		const strokes = [];
		let stroke = null;
		let lastX = 0, lastY = 0, lastZ = 0;
		let havePrev = false;

		for ( let i = 0; i < segCount; i ++ ) {

			const slot = ( start + i ) % MAX_SEGMENTS;
			const offset = slot * FLOATS_PER_SEGMENT;

			// midpoint(pL, pR) === prev; midpoint(cL, cR) === curr
			const px = Math.round( ( p[ offset + 0 ] + p[ offset + 3 ] ) * 0.5 * QUANTIZE );
			const py = Math.round( ( p[ offset + 1 ] + p[ offset + 4 ] ) * 0.5 * QUANTIZE );
			const pz = Math.round( ( p[ offset + 2 ] + p[ offset + 5 ] ) * 0.5 * QUANTIZE );
			const cx = Math.round( ( p[ offset +  6 ] + p[ offset + 12 ] ) * 0.5 * QUANTIZE );
			const cy = Math.round( ( p[ offset +  7 ] + p[ offset + 13 ] ) * 0.5 * QUANTIZE );
			const cz = Math.round( ( p[ offset +  8 ] + p[ offset + 14 ] ) * 0.5 * QUANTIZE );

			// Serialized at full (base) alpha, not the currently-faded
			// live value — only reached when lifetime is Infinity anyway
			// (see DriftMarks._save()), where nothing ever fades.
			const aByte = Math.round( this.baseAlphas[ slot ] * 255 );

			const continued = havePrev && px === lastX && py === lastY && pz === lastZ;

			if ( ! continued ) {

				stroke = { a: [ px, py, pz ], d: [], i: [] };
				strokes.push( stroke );
				stroke.d.push( cx - px, cy - py, cz - pz );

			} else {

				stroke.d.push( cx - lastX, cy - lastY, cz - lastZ );

			}

			stroke.i.push( aByte );
			lastX = cx; lastY = cy; lastZ = cz;
			havePrev = true;

		}

		return strokes;

	}

	load( strokes ) {

		for ( const s of strokes ) {

			let x = s.a[ 0 ];
			let y = s.a[ 1 ];
			let z = s.a[ 2 ];
			_replayPrev.set( x / QUANTIZE, y / QUANTIZE, z / QUANTIZE );

			const intensities = s.i;
			const deltas = s.d;
			const segs = intensities.length;

			for ( let n = 0; n < segs; n ++ ) {

				x += deltas[ n * 3 + 0 ];
				y += deltas[ n * 3 + 1 ];
				z += deltas[ n * 3 + 2 ];
				_replayCurr.set( x / QUANTIZE, y / QUANTIZE, z / QUANTIZE );

				this._writeSegment( _replayPrev, _replayCurr, intensities[ n ] / 255, false );
				_replayPrev.copy( _replayCurr );

			}

		}

		this.geometry.attributes.position.needsUpdate = true;
		this.geometry.attributes.color.needsUpdate = true;

	}

}

export class DriftMarks {

	// scale: same idea as SmokeTrails' own `scale` param in Particles.js —
	// WIDTH, MIN_SEGMENT_LENGTH, and Y_OFFSET below are all real-world
	// meters, tuned for NORMAL mode's 1:1 scale. The AR floating track/
	// arena shrink everything by FIXED_SCALE via a wrapping transform
	// group, so those constants need the same shrink applied to stay
	// proportional to the (now tiny) car — otherwise the trail floats
	// miles above the tabletop car, or never renders at all (see the
	// MIN_SEGMENT_LENGTH comment below). Defaults to 1 (no change) for
	// every existing caller, including NORMAL/web mode.
	//
	// lifetime: real seconds a mark stays visible before fading out
	// completely. Defaults to Infinity — marks never fade (the original
	// behavior) and are saved/restored via localStorage across reloads,
	// exactly as before, for every existing caller (NORMAL/web mode's
	// "persistent track record" feature is untouched). Passing a finite
	// value (used by the AR floating track/arena, after feedback that
	// marks stayed on the ground too long) switches to a live-session-
	// only fade effect instead — localStorage persistence is skipped
	// entirely in that case, since a saved mark carries no age
	// information and would otherwise reappear at full strength on the
	// next reload regardless of how long it had already faded.
	constructor( scene, trackId, scale = 1, lifetime = Infinity ) {

		this.scale = scale;
		this.lifetime = lifetime;
		this.clock = 0; // running total time, used for age-based fade-out

		const material = new THREE.MeshBasicMaterial( {
			color: 0x111111,
			transparent: true,
			opacity: 0.5,
			vertexColors: true,
			depthWrite: false,
			side: THREE.DoubleSide,
			polygonOffset: true,
			polygonOffsetFactor: - 4,
			polygonOffsetUnits: - 4,
		} );

		this.trails = [
			new DriftTrail( scene, material, scale ),
			new DriftTrail( scene, material, scale ),
		];

		this.storageKey = STORAGE_PREFIX + ( trackId || 'default' );

		if ( isFinite( this.lifetime ) ) return; // fading marks: live-session only, nothing to persist

		this._load();
		window.addEventListener( 'pagehide', () => this._save() );

	}

	update( dt, vehicle ) {

		this.clock += dt;

		const emit = vehicle.driftIntensity > 0.5 && Math.abs( vehicle.linearSpeed ) > 0.15;

		if ( emit || this.trails[ 0 ].active || this.trails[ 1 ].active ) {

			// World-space Y, not local — see the identical fix/comment in
			// Particles.js (SmokeTrails.update) for why: container.position
			// is only world position when container's parent is the scene
			// at identity transform. No-op in NORMAL mode.
			// Y_OFFSET is scaled by this.scale for the same reason WIDTH/
			// MIN_SEGMENT_LENGTH are in _writeSegment() — a real 5cm offset
			// is huge relative to an AR-shrunk car, and would float the
			// trail well above the visible tabletop ground.
			const groundY = vehicle.container.getWorldPosition( _containerWorldPos ).y + Y_OFFSET * this.scale;
			const intensity = vehicle.driftIntensity;

			this.trails[ 0 ].track( vehicle.wheelBL, groundY, intensity, emit, this.clock );
			this.trails[ 1 ].track( vehicle.wheelBR, groundY, intensity, emit, this.clock );

		}

		// Keeps fading already-written marks even once the car stops
		// drifting — a mark laid a few seconds ago shouldn't freeze in
		// place just because emit is currently false. No-op when
		// lifetime is Infinity (see updateFade's own comment).
		if ( isFinite( this.lifetime ) ) {

			this.trails[ 0 ].updateFade( this.clock, this.lifetime );
			this.trails[ 1 ].updateFade( this.clock, this.lifetime );

		}

	}

	_load() {

		try {

			const raw = localStorage.getItem( this.storageKey );
			if ( ! raw ) return;
			const data = JSON.parse( raw );
			if ( ! data || data.v !== STORAGE_VERSION || ! Array.isArray( data.t ) ) return;

			for ( let i = 0; i < this.trails.length; i ++ ) {

				const strokes = data.t[ i ];
				if ( Array.isArray( strokes ) ) this.trails[ i ].load( strokes );

			}

		} catch {}

	}

	_save() {

		if ( isFinite( this.lifetime ) ) return; // fading marks are never persisted (see constructor comment)
		if ( ! this.trails.some( ( trail ) => trail.dirty ) ) return;

		try {

			const t = this.trails.map( ( trail ) => trail.serialize() );

			if ( t.every( ( s ) => s.length === 0 ) ) {

				localStorage.removeItem( this.storageKey );

			} else {

				localStorage.setItem( this.storageKey, JSON.stringify( { v: STORAGE_VERSION, t } ) );

			}

			for ( const trail of this.trails ) trail.dirty = false;

		} catch {}

	}

}

import * as THREE from 'three';

// Rear-corner flag: a thin pole + a subdivided cloth plane, pinned to the
// pole along its left edge and animated per-frame with a traveling wave
// so it looks like real fabric catching the wind — not a rigid decal.
// Flutter amplitude/speed scale with the vehicle's speed (0..1, from
// linearSpeed / MAX_SPEED), matching how a real flag goes from a lazy
// droop at a standstill to a stiff snap at speed.

const WIDTH = 2.0; // real flag proportions (~2:3), sized against the car body
const HEIGHT = 1.3;
const SEG_X = 16;
const SEG_Y = 10;
const POLE_HEIGHT = 1.5;
const POLE_RADIUS = 0.022;

// How the pole is aimed off the vehicle's rear-left corner. This matters
// a lot for visibility: the flag's broad face is roughly perpendicular
// to its streaming direction (like any real flag), and the default
// in-game camera chases from behind — so a yaw near 90° (streaming
// almost straight back) puts the flag nearly edge-on to that camera,
// making a genuinely large flag look like a thin sliver. A shallower
// yaw keeps it angled out to the side, where the chase camera actually
// sees its full width.
const FLAG_YAW = THREE.MathUtils.degToRad( 50 );
const FLAG_PITCH = 0; // upright pole, no backward lean

function createPlaceholderTexture() {

	// Plain placeholder banner (solid field + thin trim) shown until a
	// real image is supplied — obviously a placeholder, not trying to
	// look like a real flag on its own.
	const w = 256, h = 160;
	const canvas = document.createElement( 'canvas' );
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#158443';
	ctx.fillRect( 0, 0, w, h );
	ctx.strokeStyle = 'rgba(255,255,255,0.3)';
	ctx.lineWidth = 8;
	ctx.strokeRect( 4, 4, w - 8, h - 8 );

	return new THREE.CanvasTexture( canvas );

}

// imageUrl: optional path to a custom flag image (e.g. 'images/flag.png').
// Falls back to the placeholder banner above if omitted or if it fails
// to load. Returns { group, updateFlutter( dt, windStrength01 ) } — add
// `group` under the vehicle's bodyNode, call updateFlutter() every frame.
export function createFlag( imageUrl ) {

	const group = new THREE.Group();
	group.rotation.order = 'YXZ'; // yaw first (face outward/back), then pitch (lean the pole)
	group.rotation.y = FLAG_YAW;
	group.rotation.x = FLAG_PITCH;

	const pole = new THREE.Mesh(
		new THREE.CylinderGeometry( POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 6 ),
		new THREE.MeshStandardMaterial( { color: 0x2a2a2a, roughness: 0.6, metalness: 0.3 } )
	);
	pole.position.y = POLE_HEIGHT / 2;
	group.add( pole );

	// Cloth geometry: left edge translated to local x=0 so that edge is
	// the one pinned to the pole — the wave below grows with distance
	// from that pinned edge, like real fabric anchored at one side.
	const geometry = new THREE.PlaneGeometry( WIDTH, HEIGHT, SEG_X, SEG_Y );
	geometry.translate( WIDTH / 2, 0, 0 );

	const material = new THREE.MeshStandardMaterial( {
		side: THREE.DoubleSide, roughness: 0.9, metalness: 0,
		map: createPlaceholderTexture(),
	} );

	if ( imageUrl ) {

		new THREE.TextureLoader().load( imageUrl, ( tex ) => {

			tex.colorSpace = THREE.SRGBColorSpace;
			material.map = tex;
			material.needsUpdate = true;

		}, undefined, () => {

			console.warn( 'Flag image failed to load, keeping placeholder:', imageUrl );

		} );

	}

	const cloth = new THREE.Mesh( geometry, material );
	cloth.position.y = POLE_HEIGHT - HEIGHT / 2 - 0.01;
	group.add( cloth );

	const basePositions = geometry.attributes.position.array.slice();
	let t = 0;

	function updateFlutter( dt, windStrength01 ) {

		t += dt;

		const w = THREE.MathUtils.clamp( windStrength01, 0, 1 );

		// At rest (w=0) the flag hangs down and collapses in toward the
		// pole under its own weight, like real fabric with no wind to
		// hold it out. At speed (w=1) it's blown fully out to its flat,
		// horizontal shape. `collapse` blends between those two states —
		// this is the dominant shape, not a small offset on top of a
		// rigid rectangle.
		const collapse = 1 - w;
		const amp = ( 0.015 + w * 0.16 ) * HEIGHT; // flutter itself stays subtle at rest, pronounced at speed
		const freq = 5.5 / HEIGHT;
		const speed = 6 + w * 9;

		const pos = geometry.attributes.position;
		const arr = pos.array;

		for ( let i = 0; i < arr.length; i += 3 ) {

			const bx = basePositions[ i ];
			const by = basePositions[ i + 1 ];
			const distFromPole = bx / WIDTH; // 0 at the pinned edge, 1 at the free edge

			// Gravity droop: the free edge sags down and pulls in toward
			// the pole as wind drops off (exponent >1 so it's a soft
			// curve near the pole, steeper toward the free edge — real
			// fabric doesn't droop linearly).
			const droopY = collapse * HEIGHT * 0.6 * Math.pow( distFromPole, 1.4 );
			const pullX = collapse * bx * 0.55;

			const wave = Math.sin( bx * freq - t * speed ) * amp * distFromPole;
			// Same phase basis as `wave` (no height-dependent offset) so
			// top and bottom stay in sync — a by-dependent phase here
			// made the whole flag look permanently skewed/tilted in any
			// single frame instead of fluttering evenly.
			const wave2 = Math.sin( bx * freq * 1.7 - t * speed * 1.3 ) * amp * 0.35 * distFromPole;

			arr[ i ] = bx - pullX;
			arr[ i + 1 ] = by - droopY;
			arr[ i + 2 ] = wave + wave2;

		}

		pos.needsUpdate = true;
		geometry.computeVertexNormals();

	}

	return { group, updateFlutter };

}

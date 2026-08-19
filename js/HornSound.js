// Procedural car horn — a classic dual-tone electromagnetic horn. Unlike
// tire skid (organic friction noise, hard to synthesize convincingly),
// a real car horn is two fixed-pitch diaphragms buzzing together, which
// synthesizes well: two detuned square/sawtooth oscillators a musical
// interval apart, mildly overdriven for that buzzy "electric horn" edge.
//
// Rendered once into a short seamless loop, played back with looping
// while the horn button is held (see Audio.js setHorn()).

const DURATION = 0.25; // seconds, one loop — short and tight, like a real horn

// Tone frequencies are snapped to exact multiples of 1/DURATION (4 Hz)
// so both oscillators complete a whole number of cycles per loop and
// wrap with zero phase discontinuity — unlike noise, a periodic tone
// would click audibly at the seam otherwise. 416/312 Hz are close
// enough to the classic 415/311 Hz horn pitches to sound identical.
const TONE_A = 416; // Hz — near G#4, classic higher horn pitch
const TONE_B = 312; // Hz — near D#4, classic lower horn pitch (a fourth below)

function sawtooth( phase ) {

	return 2 * ( phase - Math.floor( phase + 0.5 ) );

}

export function fillHorn( data, sampleRate ) {

	const n = data.length;

	for ( let i = 0; i < n; i ++ ) {

		// Phase computed directly from the sample index (not accumulated)
		// so there's zero floating-point drift by the time we reach the
		// loop seam — with integer cycle counts per loop, this makes the
		// wrap mathematically exact.
		const phaseA = ( i * TONE_A / sampleRate ) % 1;
		const phaseB = ( i * TONE_B / sampleRate ) % 1;

		const a = sawtooth( phaseA );
		const b = sawtooth( phaseB );

		// Mild overdrive gives the buzzy diaphragm edge real horns have,
		// rather than a clean, obviously-synthetic tone.
		const x = Math.tanh( ( a * 0.6 + b * 0.5 ) * 1.8 );

		data[ i ] = x;

	}

	// Normalize
	let peak = 0;
	for ( let i = 0; i < n; i ++ ) peak = Math.max( peak, Math.abs( data[ i ] ) );

	if ( peak > 0 ) {

		const norm = 0.8 / peak;
		for ( let i = 0; i < n; i ++ ) data[ i ] *= norm;

	}

}

export function createHornBuffer( context ) {

	const length = Math.floor( DURATION * context.sampleRate );
	const buffer = context.createBuffer( 1, length, context.sampleRate );

	fillHorn( buffer.getChannelData( 0 ), context.sampleRate );

	return buffer;

}

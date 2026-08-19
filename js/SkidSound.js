// Procedural tire skid/squeal loop — replaces the old sampled skid.ogg
// with a synthesized sound, matching the project's existing approach for
// the engine (EngineWorklet.js) and impacts (ImpactSound.js).
//
// Two layers:
// - Scrape: broadband rubber-on-asphalt noise through a resonant
//   bandpass whose center frequency wanders slowly, for a rough, grainy
//   texture rather than a pure tone.
// - Squeal: real tire squeal comes from the rubber alternately gripping
//   and slipping (stick-slip friction) at high frequency, producing an
//   unstable, "warbling" pitched tone — modeled here as a soft sawtooth
//   oscillator whose pitch and amplitude both wander via slow correlated
//   noise, so it never locks into an obviously-synthetic steady tone.
//
// Rendered once into a short seamless loop. Audio.js's own tone filter
// (skidTone, a lowpass swept ~2.5kHz-10kHz by drift intensity) provides
// the "opens up as the drift digs in" character on top of this at
// runtime, so this buffer just needs solid broadband content throughout.

const DURATION = 1.1; // seconds, one loop
const FADE = 0.06; // seconds, crossfaded loop seam (avoids a click at the wrap)

export function fillSkid( data, sampleRate, seed ) {

	let noiseSeed = seed * 48271 + 11;

	const random = () => {

		noiseSeed = ( noiseSeed * 1664525 + 1013904223 ) | 0;
		return ( noiseSeed >>> 9 ) / 8388608;

	};

	const fadeLen = Math.floor( FADE * sampleRate );
	const total = data.length; // scratch length = loop length + fadeLen
	const n = total - fadeLen; // final loop length

	// --- Scrape: noise through a wandering resonant bandpass -----------
	let scrapeLow = 0, scrapeBand = 0;
	let wander = 0;
	const wanderCoeff = 1 - Math.exp( - 2 * Math.PI * 3 / sampleRate ); // ~3Hz wander

	// --- Squeal: stick-slip oscillator with wandering pitch/amp --------
	let squealPhase = 0;
	let pitchWander = 0;
	const pitchWanderCoeff = 1 - Math.exp( - 2 * Math.PI * 2.2 / sampleRate );
	let ampWander = 0;
	const ampWanderCoeff = 1 - Math.exp( - 2 * Math.PI * 4.5 / sampleRate );

	const raw = new Float32Array( total );

	for ( let i = 0; i < total; i ++ ) {

		// Scrape: bandpass center wanders roughly 1200-2600 Hz
		wander += ( random() * 2 - 1 - wander ) * wanderCoeff;
		const fc = 1900 + wander * 700;
		const svfF = 2 * Math.sin( Math.PI * Math.min( 0.28, fc / sampleRate ) );
		const white = random() * 2 - 1;
		scrapeLow += svfF * scrapeBand;
		const high = white - scrapeLow - 0.55 * scrapeBand;
		scrapeBand += svfF * high;
		const scrape = scrapeBand * 0.9;

		// Squeal: soft sawtooth, pitch + amp both wander for the
		// characteristic unstable "warble" of real tire squeal
		pitchWander += ( random() * 2 - 1 - pitchWander ) * pitchWanderCoeff;
		ampWander += ( random() * 2 - 1 - ampWander ) * ampWanderCoeff;
		const squealFreq = 950 + pitchWander * 550; // ~400-1500 Hz range
		squealPhase += squealFreq / sampleRate;
		squealPhase -= Math.floor( squealPhase );
		let saw = 2 * squealPhase - 1;
		saw = Math.tanh( saw * 1.6 ) / Math.tanh( 1.6 ); // soften the edge, less "buzzy"
		const squealAmp = 0.35 + Math.max( 0, ampWander ) * 0.35;

		raw[ i ] = scrape * 0.65 + saw * squealAmp * 0.55;

	}

	// Crossfade the rendered tail back into the head so the loop wraps
	// without a click (the filters/oscillators keep running continuously
	// through the extra `fadeLen` tail samples, so the blend is a real
	// continuation, not a jump).
	for ( let i = 0; i < n; i ++ ) {

		if ( i < fadeLen ) {

			const w = i / fadeLen;
			data[ i ] = raw[ i ] * w + raw[ n + i ] * ( 1 - w );

		} else {

			data[ i ] = raw[ i ];

		}

	}

	// Normalize
	let peak = 0;
	for ( let i = 0; i < n; i ++ ) peak = Math.max( peak, Math.abs( data[ i ] ) );

	if ( peak > 0 ) {

		const norm = 0.85 / peak;
		for ( let i = 0; i < n; i ++ ) data[ i ] *= norm;

	}

}

export function createSkidBuffer( context, seed = 7 ) {

	const fadeLen = Math.floor( FADE * context.sampleRate );
	const loopLen = Math.floor( DURATION * context.sampleRate );
	const buffer = context.createBuffer( 1, loopLen, context.sampleRate );

	const scratch = new Float32Array( loopLen + fadeLen );
	fillSkid( scratch, context.sampleRate, seed );
	buffer.getChannelData( 0 ).set( scratch.subarray( 0, loopLen ) );

	return buffer;

}

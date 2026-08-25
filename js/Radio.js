import * as THREE from 'three';

// Simple 3-track car radio. Positional audio attached to the vehicle so it
// sounds like it's coming from the car, reusing the same THREE.AudioListener
// GameAudio already created (one listener per document, shared).

const TRACK_URLS = [
	'audio/radio/radio-1.mp3',
	'audio/radio/radio-2.mp3',
	'audio/radio/radio-3.mp3',
];

export class Radio {

	constructor( listener, target ) {

		this.sound = new THREE.PositionalAudio( listener );
		this.sound.setRefDistance( 4 );
		this.sound.setRolloffFactor( 1.5 );
		this.sound.setVolume( 1.6 ); // raised again per feedback — engine/skid/impact came down, radio should stand out more now
		target.add( this.sound );

		this.loader = new THREE.AudioLoader();
		this.buffers = [ null, null, null ];
		this.loadPromises = TRACK_URLS.map( ( url, i ) =>
			new Promise( ( resolve ) => {

				this.loader.load( url,
					( buffer ) => { this.buffers[ i ] = buffer; resolve(); },
					undefined,
					( err ) => { console.warn( '[Radio] failed to load', url, err ); resolve(); }
				);

			} )
		);

		this.trackIndex = -1;
		this.playing = false;

	}

	// Advances to the next loaded track and starts playing it (wraps
	// around after the 3rd). Safe to call before loading finishes — it
	// will just pick whichever tracks are ready.
	next() {

		const available = this.buffers.map( ( b, i ) => b ? i : null ).filter( ( i ) => i !== null );
		if ( available.length === 0 ) return;

		let idx = ( this.trackIndex + 1 ) % 3;
		// skip any track that failed to load
		for ( let tries = 0; tries < 3 && ! this.buffers[ idx ]; tries ++ ) {

			idx = ( idx + 1 ) % 3;

		}

		if ( ! this.buffers[ idx ] ) return;

		this.trackIndex = idx;

		if ( this.sound.isPlaying ) this.sound.stop();
		this.sound.setBuffer( this.buffers[ idx ] );
		this.sound.setLoop( true );
		this.sound.play();
		this.playing = true;

	}

	togglePlayPause() {

		if ( this.trackIndex === -1 ) {

			// Nothing chosen yet — start on track 1.
			this.next();
			return;

		}

		if ( this.playing ) {

			this.sound.pause();
			this.playing = false;

		} else {

			this.sound.play();
			this.playing = true;

		}

	}

	stop() {

		if ( this.sound.isPlaying ) this.sound.stop();
		this.playing = false;

	}

}

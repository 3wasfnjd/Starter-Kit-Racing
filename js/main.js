import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { LightProbeGridHelper } from 'three/addons/helpers/LightProbeGridHelper.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle, MAX_SPEED } from './Vehicle.js';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds, computeTrackPath, NPC_TRUCKS, TRACK_CELLS } from './Track.js';
import { buildWallColliders, createSphereBody, applyArTransform } from './Physics.js';
import { SmokeTrails } from './Particles.js';
import { DriftMarks } from './DriftMarks.js';
import { GameAudio } from './Audio.js';
import { createFlag } from './Flag.js';
import { LapTimer } from './LapTimer.js';
import { ColorMapGLTFLoader } from './Loader.js';
import { ARManager } from './ARManager.js';
import { PlaceableObject } from './PlaceableObject.js';
import { Radio } from './Radio.js';


const renderer = new THREE.WebGLRenderer( { antialias: true, alpha: true, outputBufferType: THREE.HalfFloatType } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( window.devicePixelRatio );
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.xr.enabled = true; // required so main.js can offer AR MODE; NORMAL mode is unaffected

const bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ) );
bloomPass.strength = 0.02;
bloomPass.radius = 0.02;
bloomPass.threshold = 0.5;

renderer.setEffects( [ bloomPass ] );

document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0xadb2ba );
scene.fog = new THREE.Fog( 0xadb2ba, 30, 55 );

const dirLight = new THREE.DirectionalLight( 0xffffff, 3 );
dirLight.position.set( 11.4, 15, -5.3 );
dirLight.castShadow = true;
dirLight.shadow.mapSize.setScalar( 4096 );
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 60;
dirLight.shadow.radius = 4;
scene.add( dirLight );

const hemiLight = new THREE.HemisphereLight( 0xc8d8e8, 0x7a8a5a, 2 );
hemiLight.position.copy( dirLight.position )
scene.add( hemiLight );


window.addEventListener( 'resize', () => {

	renderer.setSize( window.innerWidth, window.innerHeight );

} );

const loader = new ColorMapGLTFLoader();

const modelNames = [
	'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red',
	'track-straight', 'track-corner', 'track-bump', 'track-finish',
	'decoration-empty', 'decoration-forest', 'decoration-tents',
	'ground-tile', 'barrier-segment',
];

const models = {};

async function loadModels() {

	const promises = modelNames.map( ( name ) =>
		new Promise( ( resolve, reject ) => {

			loader.load( `models/${ name }.glb`, ( gltf ) => {

				const meshes = [];
				gltf.scene.traverse( ( child ) => {

					if ( child.isMesh ) {

						child.material.side = THREE.FrontSide;
						meshes.push( child );

					}

				} );

				// Godot imports vehicle models at root_scale=0.5
				if ( name.startsWith( 'vehicle-' ) ) {

					gltf.scene.scale.setScalar( 0.5 );

				}

				if ( meshes.length === 1 ) {

					const mesh = meshes[ 0 ];
					mesh.removeFromParent();
					models[ name ] = mesh;

				} else {

					models[ name ] = gltf.scene;

				}

				resolve();

			}, undefined, reject );

		} )
	);

	await Promise.all( promises );

}

// ─── Mode selection menu ──────────────────────────────────
// Neither existing markup nor CSS is touched; this overlay is created
// entirely from main.js so index.html stays untouched too.

// Requests fullscreen on the whole page. Must be called synchronously
// inside a user-gesture handler (click) or the browser will silently
// refuse. Not all mobile browsers support this (notably iPhone Safari
// does not support Element.requestFullscreen at all) — fails silently
// there, the game still works fine, just not edge-to-edge.
function requestFullscreenSafe() {

	const el = document.documentElement;
	const request = el.requestFullscreen || el.webkitRequestFullscreen ||
		el.mozRequestFullScreen || el.msRequestFullscreen;

	if ( ! request ) return;

	try {

		const result = request.call( el );
		if ( result && result.catch ) result.catch( ( e ) => console.warn( 'Fullscreen request failed:', e ) );

	} catch ( e ) {

		console.warn( 'Fullscreen request failed:', e );

	}

}

function createModeMenu( { arAvailable } ) {

	return new Promise( ( resolve ) => {

		const style = document.createElement( 'style' );
		style.textContent = `
			#hajwalah-menu * { box-sizing: border-box; }
			#hajwalah-menu {
				position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
				background: radial-gradient(circle at 50% 20%, #1a1030 0%, #0a0a12 55%, #050508 100%);
				font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 24px 16px; overflow-y: auto;
			}
			#hajwalah-menu .hw-wrap { display: flex; flex-direction: column; align-items: center; gap: 14px; max-width: 420px; width: 100%; }
			#hajwalah-menu .hw-logo { width: 120px; height: 120px; border-radius: 20px; filter: drop-shadow(0 0 22px rgba(139,95,191,0.55)); }
			#hajwalah-menu .hw-title {
				font-size: 32px; font-weight: 800; text-align: center; letter-spacing: 1px;
				background: linear-gradient(90deg, #8B5FBF 0%, #5B8CFF 50%, #4FD8E8 100%);
				-webkit-background-clip: text; background-clip: text; color: transparent;
				margin: 4px 0 0;
			}
			#hajwalah-menu .hw-subtitle { color: #9a94b0; font-size: 12px; letter-spacing: 2px; margin-bottom: 6px; }
			#hajwalah-menu .hw-panel {
				width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(139,95,191,0.35);
				border-radius: 18px; padding: 20px; display: flex; flex-direction: column; gap: 14px;
				backdrop-filter: blur(10px);
			}
			#hajwalah-menu .hw-field-label { color: #b9b3cc; font-size: 12.5px; text-align: center; margin-bottom: 8px; }
			#hajwalah-menu input[type=text] {
				padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12);
				background: rgba(255,255,255,0.06); color: #fff; font-size: 15px; text-align: center; width: 100%; outline: none;
			}
			#hajwalah-menu .hw-swatches { display: flex; gap: 10px; justify-content: center; }
			#hajwalah-menu .hw-swatch {
				width: 60px; height: 60px; border-radius: 12px; cursor: pointer; padding: 0;
				border: 2px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05);
				display: flex; align-items: center; justify-content: center; overflow: hidden;
			}
			#hajwalah-menu .hw-swatch img { width: 90%; height: 90%; object-fit: contain; }
			#hajwalah-menu .hw-swatch.selected { border-color: #5B8CFF; box-shadow: 0 0 14px rgba(91,140,255,0.55); }
			#hajwalah-menu .hw-flag-row { display: flex; align-items: center; gap: 12px; justify-content: center; }
			#hajwalah-menu .hw-flag-pick {
				display: flex; align-items: center; justify-content: center; gap: 8px;
				padding: 10px 16px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14);
				background: rgba(255,255,255,0.06); color: #cfc9e0; font-size: 13px; cursor: pointer;
			}
			#hajwalah-menu .hw-flag-pick:active { background: rgba(255,255,255,0.12); }
			#hajwalah-menu .hw-flag-preview {
				width: 44px; height: 44px; border-radius: 8px; object-fit: cover;
				border: 1px solid rgba(255,255,255,0.18); display: none;
			}
			#hajwalah-menu .hw-flag-preview.shown { display: block; }
			#hajwalah-menu .hw-flag-clear {
				display: none; color: #ff8a8a; font-size: 12px; background: none; border: none; cursor: pointer;
			}
			#hajwalah-menu .hw-flag-clear.shown { display: inline-block; }
			#hajwalah-menu .hw-checkbox-row { display: flex; align-items: center; gap: 10px; color: #cfc9e0; font-size: 13.5px; justify-content: center; cursor: pointer; }
			#hajwalah-menu .hw-checkbox-row input { width: 20px; height: 20px; accent-color: #8B5FBF; }
			#hajwalah-menu .hw-mode-row { display: flex; gap: 12px; }
			#hajwalah-menu .hw-mode-card {
				flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px;
				padding: 16px 10px; border-radius: 14px; cursor: pointer; border: none;
				border: 1.5px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.05); color: #fff;
			}
			#hajwalah-menu .hw-mode-card.primary {
				border-color: rgba(91,140,255,0.7);
				background: linear-gradient(160deg, rgba(139,95,191,0.28), rgba(91,140,255,0.14));
				box-shadow: 0 4px 22px rgba(91,140,255,0.25);
			}
			#hajwalah-menu .hw-mode-card:disabled { opacity: 0.45; cursor: not-allowed; }
			#hajwalah-menu .hw-mode-card svg { width: 40px; height: 40px; }
			#hajwalah-menu .hw-mode-label { font-size: 13.5px; font-weight: 600; text-align: center; }
			#hajwalah-menu .hw-mode-sub { font-size: 10.5px; color: #a79fc4; text-align: center; }
			#hajwalah-menu .hw-back-link {
				color: #a79fc4; text-decoration: none; font-size: 12px; text-align: center; cursor: pointer; margin-top: -4px;
			}
			#hajwalah-menu .hw-step { display: flex; flex-direction: column; gap: 12px; }
			#hajwalah-menu .hw-step.hidden { display: none; }
			#hajwalah-menu .hw-footer { margin-top: 6px; color: #6b6680; font-size: 11.5px; text-align: center; letter-spacing: 0.5px; }
			#hajwalah-menu .hw-footer b { color: #9d8fd4; }
			#hajwalah-menu .hw-features-link {
				color: #5B8CFF; text-decoration: none; font-size: 12px; display: inline-block; margin-top: 4px;
			}
			#hajwalah-menu .hw-features-link:hover { text-decoration: underline; }
		`;

		const menu = document.createElement( 'div' );
		menu.id = 'hajwalah-menu';
		menu.dir = 'rtl';

		const VEHICLE_OPTIONS = [
			{ key: 'vehicle-truck-purple', label: 'أسود', thumb: 'images/menu/thumb-black.png' },
			{ key: 'vehicle-truck-red', label: 'أحمر', thumb: 'images/menu/thumb-red.png' },
			{ key: 'vehicle-truck-yellow', label: 'أصفر', thumb: 'images/menu/thumb-yellow.png' },
			{ key: 'vehicle-truck-green', label: 'رملي', thumb: 'images/menu/thumb-green.png' },
		];
		let selectedVehicle = VEHICLE_OPTIONS[ 0 ].key;
		const vehicleSwatches = [];

		function refreshSwatchSelection() {

			vehicleSwatches.forEach( ( sw ) => {

				sw.classList.toggle( 'selected', sw.dataset.key === selectedVehicle );

			} );

		}

		menu.innerHTML = `
			<div class="hw-wrap">
				<img class="hw-logo" src="images/menu/logo.png" alt="Aboden Games" />
				<div class="hw-title">هجولة عتابة</div>
				<div class="hw-subtitle">HAJWALAH &middot; AR RACING</div>
				<div class="hw-panel">
					<div>
						<div class="hw-field-label">نص مخصص (الزجاج الأمامي والباب الخلفي) — اختياري</div>
						<input type="text" class="hw-text-input" maxlength="12" placeholder="مثال: سباق" />
					</div>
					<div>
						<div class="hw-field-label">لون السيارة</div>
						<div class="hw-swatches"></div>
					</div>
					<div>
						<div class="hw-field-label">صورة العلم الخلفي — اختياري</div>
						<div class="hw-flag-row">
							<label class="hw-flag-pick">
								📷 اختر صورة
								<input type="file" accept="image/*" class="hw-flag-input" hidden />
							</label>
							<img class="hw-flag-preview" />
							<button type="button" class="hw-flag-clear">إزالة</button>
						</div>
					</div>
					<label class="hw-checkbox-row">
						<input type="checkbox" class="hw-freeroam-checkbox" />
						الوضع العادي: تحكم حر بدون مضمار
					</label>

					<div class="hw-step hw-step-top">
						<div class="hw-mode-row">
							<button class="hw-mode-card primary hw-web-btn">
								<svg viewBox="0 0 24 24" fill="none" stroke="#5B8CFF" stroke-width="1.6">
									<rect x="2.5" y="4.5" width="19" height="13" rx="2"/>
									<path d="M8 21h8M12 17.5v3.5"/>
								</svg>
								<div class="hw-mode-label">وضع الويب</div>
								<div class="hw-mode-sub">أيفون / كمبيوتر</div>
							</button>
							<button class="hw-mode-card hw-ar-entry-btn" ${ arAvailable ? '' : 'disabled' }>
								<svg viewBox="0 0 24 24" fill="none" stroke="#cfc9e0" stroke-width="1.6">
									<rect x="2.5" y="8" width="19" height="9" rx="3.5"/>
									<circle cx="8.3" cy="12.5" r="1.9"/>
									<circle cx="15.7" cy="12.5" r="1.9"/>
									<path d="M9.8 12.5h4.4"/>
									<path d="M6 8c0-2.2 1.8-4 4-4h4c2.2 0 4 1.8 4 4"/>
								</svg>
								<div class="hw-mode-label">وضع AR</div>
								<div class="hw-mode-sub">${ arAvailable ? 'Meta Quest 3' : 'غير متاح على هذا الجهاز' }</div>
							</button>
						</div>
					</div>

					<div class="hw-step hw-step-ar hidden">
						<div class="hw-mode-row">
							<button class="hw-mode-card primary hw-ar-room-btn">
								<svg viewBox="0 0 24 24" fill="none" stroke="#5B8CFF" stroke-width="1.6">
									<path d="M4 20V9l8-5 8 5v11" /><path d="M9 20v-6h6v6" />
								</svg>
								<div class="hw-mode-label">حر بالغرفة</div>
								<div class="hw-mode-sub">قيادة حقيقية بمكانك</div>
							</button>
							<button class="hw-mode-card hw-ar-track-btn">
								<svg viewBox="0 0 24 24" fill="none" stroke="#cfc9e0" stroke-width="1.6">
									<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="#cfc9e0" stroke="none"/>
								</svg>
								<div class="hw-mode-label">مضمار عائم</div>
								<div class="hw-mode-sub">مضمار مصغّر</div>
							</button>
							<button class="hw-mode-card hw-ar-arena-btn">
								<svg viewBox="0 0 24 24" fill="none" stroke="#cfc9e0" stroke-width="1.6">
									<rect x="4" y="9" width="16" height="9" rx="1.5"/><path d="M4 9l8-5 8 5"/>
								</svg>
								<div class="hw-mode-label">حلبة عائمة</div>
								<div class="hw-mode-sub">حلبة تفحيط مصغّرة</div>
							</button>
						</div>
						<a href="#" class="hw-back-link">‹ رجوع</a>
					</div>
				</div>
				<div class="hw-footer">
					<b>ABODEN GAMES</b> &nbsp;&middot;&nbsp; &copy; 2026 &nbsp;&middot;&nbsp; جميع الحقوق محفوظة
					<br/><a href="#" class="hw-features-link">✨ عن اللعبة</a>
				</div>
			</div>
		`;

		document.head.appendChild( style );

		const swatchRow = menu.querySelector( '.hw-swatches' );
		VEHICLE_OPTIONS.forEach( ( opt ) => {

			const sw = document.createElement( 'button' );
			sw.className = 'hw-swatch';
			sw.dataset.key = opt.key;
			sw.title = opt.label;
			sw.innerHTML = `<img src="${ opt.thumb }" alt="${ opt.label }" />`;
			sw.addEventListener( 'click', () => {

				selectedVehicle = opt.key;
				refreshSwatchSelection();

			} );
			vehicleSwatches.push( sw );
			swatchRow.appendChild( sw );

		} );
		refreshSwatchSelection();

		// Flag image: read locally as a data URL via FileReader — no
		// server/upload involved, works fully offline, and the resulting
		// data: URL is exactly what THREE.TextureLoader/createFlag()
		// already accepts as an imageUrl.
		let flagImageDataUrl = null;
		const flagInput = menu.querySelector( '.hw-flag-input' );
		const flagPreview = menu.querySelector( '.hw-flag-preview' );
		const flagClear = menu.querySelector( '.hw-flag-clear' );

		flagInput.addEventListener( 'change', () => {

			const file = flagInput.files && flagInput.files[ 0 ];
			if ( ! file ) return;

			const reader = new FileReader();
			reader.onload = () => {

				flagImageDataUrl = reader.result;
				flagPreview.src = flagImageDataUrl;
				flagPreview.classList.add( 'shown' );
				flagClear.classList.add( 'shown' );

			};
			reader.readAsDataURL( file );

		} );

		flagClear.addEventListener( 'click', () => {

			flagImageDataUrl = null;
			flagInput.value = '';
			flagPreview.classList.remove( 'shown' );
			flagClear.classList.remove( 'shown' );

		} );

		const textInput = menu.querySelector( '.hw-text-input' );
		const freeRoamCheckbox = menu.querySelector( '.hw-freeroam-checkbox' );
		const freeRoamRow = menu.querySelector( '.hw-checkbox-row' );
		const webBtn = menu.querySelector( '.hw-web-btn' );
		const arEntryBtn = menu.querySelector( '.hw-ar-entry-btn' );
		const stepTop = menu.querySelector( '.hw-step-top' );
		const stepAr = menu.querySelector( '.hw-step-ar' );
		const arRoomBtn = menu.querySelector( '.hw-ar-room-btn' );
		const backLink = menu.querySelector( '.hw-back-link' );

		webBtn.addEventListener( 'click', () => {

			requestFullscreenSafe();
			menu.remove();
			resolve( { choice: 'normal', customText: textInput.value.trim(), freeRoam: freeRoamCheckbox.checked, vehicleKey: selectedVehicle, flagImage: flagImageDataUrl } );

		} );

		// Entering AR is now a two-step pick: which AR experience, not
		// just "AR yes/no" — the free-roam checkbox above only means
		// anything for the web mode, so it's hidden once inside the AR
		// step to avoid implying it affects the AR sub-choice below it.
		arEntryBtn.addEventListener( 'click', () => {

			if ( arEntryBtn.disabled ) return;
			stepTop.classList.add( 'hidden' );
			stepAr.classList.remove( 'hidden' );
			freeRoamRow.classList.add( 'hidden' );

		} );

		backLink.addEventListener( 'click', ( e ) => {

			e.preventDefault();
			stepAr.classList.add( 'hidden' );
			stepTop.classList.remove( 'hidden' );
			freeRoamRow.classList.remove( 'hidden' );

		} );

		arRoomBtn.addEventListener( 'click', () => {

			// No requestFullscreenSafe() here on purpose: it would consume
			// the click's transient user-activation, and requestSession()
			// below needs that same activation. AR sessions take over the
			// whole display anyway, so it's moot.
			//
			// requestSession() itself is also started HERE, synchronously,
			// rather than later inside startARMode() — some browsers only
			// honor user-activation for a call made directly in the event
			// handler, not after several chained await hops. The resulting
			// promise is handed off and awaited downstream.
			const sessionPromise = navigator.xr.requestSession( 'immersive-ar', {
				requiredFeatures: [ 'local-floor', 'hit-test' ],
				optionalFeatures: [ 'plane-detection', 'mesh-detection' ],
			} );

			menu.remove();
			resolve( {
				choice: 'ar', arSubMode: 'room', customText: textInput.value.trim(),
				vehicleKey: selectedVehicle, flagImage: flagImageDataUrl, sessionPromise,
			} );

		} );

		// hw-ar-arena-btn is still a `disabled` placeholder ("قريبًا") —
		// wired up once the floating arena is built (a later stage).
		const arTrackBtn = menu.querySelector( '.hw-ar-track-btn' );
		arTrackBtn.addEventListener( 'click', () => {

			const sessionPromise = navigator.xr.requestSession( 'immersive-ar', {
				requiredFeatures: [ 'local-floor' ],
				optionalFeatures: [ 'plane-detection', 'mesh-detection' ],
			} );

			menu.remove();
			resolve( { choice: 'ar', arSubMode: 'track', vehicleKey: selectedVehicle, customText: textInput.value.trim(), flagImage: flagImageDataUrl, sessionPromise } );

		} );

		const arArenaBtn = menu.querySelector( '.hw-ar-arena-btn' );
		arArenaBtn.addEventListener( 'click', () => {

			const sessionPromise = navigator.xr.requestSession( 'immersive-ar', {
				requiredFeatures: [ 'local-floor' ],
				optionalFeatures: [ 'plane-detection', 'mesh-detection' ],
			} );

			menu.remove();
			resolve( { choice: 'ar', arSubMode: 'arena', vehicleKey: selectedVehicle, sessionPromise } );

		} );

		const featuresLink = menu.querySelector( '.hw-features-link' );
		featuresLink.addEventListener( 'click', ( e ) => {

			e.preventDefault();
			showFeaturesModal();

		} );

		document.body.appendChild( menu );

	} );

}

// ─── "What's new" features modal ───────────────────────────
// Summarizes the major additions built on top of the original starter
// kit — opened from a link in the main menu's footer.

function showFeaturesModal() {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-features-overlay {
			position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
			background: rgba(5,5,10,0.75); font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 24px 16px;
		}
		#hw-features-overlay .hwf-card {
			max-width: 460px; width: 100%; max-height: 82vh; overflow-y: auto;
			background: radial-gradient(circle at 50% 0%, #201436 0%, #0d0d16 70%);
			border: 1px solid rgba(139,95,191,0.4); border-radius: 20px; padding: 26px 22px;
			box-shadow: 0 0 50px rgba(91,60,140,0.25);
		}
		#hw-features-overlay .hwf-title {
			font-size: 26px; font-weight: 800; text-align: center;
			background: linear-gradient(90deg, #8B5FBF 0%, #5B8CFF 50%, #4FD8E8 100%);
			-webkit-background-clip: text; background-clip: text; color: transparent;
			margin-bottom: 4px;
		}
		#hw-features-overlay .hwf-sub { color: #9a94b0; font-size: 12px; text-align: center; margin-bottom: 20px; }
		#hw-features-overlay .hwf-row {
			display: flex; align-items: flex-start; gap: 12px; padding: 12px 0;
			border-top: 1px solid rgba(255,255,255,0.08);
		}
		#hw-features-overlay .hwf-row:first-of-type { border-top: none; }
		#hw-features-overlay .hwf-icon { font-size: 20px; line-height: 1.3; flex-shrink: 0; width: 26px; text-align: center; }
		#hw-features-overlay .hwf-label { color: #fff; font-size: 14.5px; font-weight: 600; margin-bottom: 2px; }
		#hw-features-overlay .hwf-desc { color: #a79fc4; font-size: 12.5px; line-height: 1.5; }
		#hw-features-overlay .hwf-close {
			display: block; width: 100%; margin-top: 20px; padding: 13px; border: none; border-radius: 999px;
			background: linear-gradient(90deg, #8B5FBF, #5B8CFF); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
		}
		#hw-features-overlay .hwf-about {
			background: rgba(139,95,191,0.1); border: 1px solid rgba(139,95,191,0.3); border-radius: 12px;
			padding: 12px 14px; margin-bottom: 18px; color: #cfc9e0; font-size: 12.5px; line-height: 1.7; text-align: center;
		}
		#hw-features-overlay .hwf-about b { color: #fff; }
	`;

	const FEATURES = [
		{ icon: '🕶️', label: 'وضع الواقع المعزز (AR)', desc: 'تشغيل حقيقي على Meta Quest 3 — تحدد مكان اللعب بغرفتك الحقيقية وتسوق بحرية كاملة بدون مضمار ثابت، مع سياج حماية يمنع السقوط من الحافة.' },
		{ icon: '🚙', label: 'اختيار لون/شكل السيارة', desc: '4 ألوان مختلفة تقدر تختارها قبل الدخول، تشوف صورة فعلية للسيارة قبل الاختيار.' },
		{ icon: '✏️', label: 'نص مخصص على السيارة', desc: 'اكتب أي كلمة أو اسم، ويظهر كملصق على الزجاج الأمامي والباب الخلفي.' },
		{ icon: '📻', label: 'راديو داخل السيارة', desc: '3 مقاطع صوتية تتحكم فيها أثناء القيادة — تبديل وتشغيل/إيقاف، بالكيبورد أو اللمس أو أيادي Quest.' },
		{ icon: '💡', label: 'إضاءة كاملة وواقعية', desc: 'أضواء أمامية حقيقية تضيء المكان، إضاءة عالية بالتكبيس، أضواء خلفية، وطوارئ برتقالية وامضة — كلها بأزرار تحكم مخصصة.' },
		{ icon: '🔎', label: 'تكبير وتصغير السيارة حي', desc: 'غيّر حجم السيارة أثناء اللعب مباشرة، مفيد لو تبي تلعب فوق طاولة بدل الأرض.' },
		{ icon: '🌍', label: 'تحكم حر بدون مضمار', desc: 'خيار بالوضع العادي كمان — أرضية مفتوحة واسعة تسوق فيها بحرية بدون قيود مضمار.' },
		{ icon: '📱', label: 'دعم كل الأجهزة', desc: 'يشتغل بالكيبورد، لمس الجوال، أو أيادي تحكم Quest — كل الميزات متاحة بأي طريقة تلعب فيها.' },
	];

	const overlay = document.createElement( 'div' );
	overlay.id = 'hw-features-overlay';
	overlay.dir = 'rtl';
	overlay.innerHTML = `
		<div class="hwf-card">
			<div class="hwf-title">هجولة عتابة</div>
			<div class="hwf-sub">مميزات اللعبة</div>
			<div class="hwf-about">
				طوّر هذه اللعبة <b>ABODEN GAMES</b> بمساعدة <b>Claude</b> من Anthropic.
				<br/>المشروع الأصلي: <b>Kenney</b> (تصميم) · <b>mrdoob</b> (Three.js) · <b>crashcat</b> (فيزياء).
			</div>
			${ FEATURES.map( ( f ) => `
				<div class="hwf-row">
					<div class="hwf-icon">${ f.icon }</div>
					<div>
						<div class="hwf-label">${ f.label }</div>
						<div class="hwf-desc">${ f.desc }</div>
					</div>
				</div>
			` ).join( '' ) }
			<button class="hwf-close">رجوع</button>
		</div>
	`;

	document.head.appendChild( style );
	document.body.appendChild( overlay );

	overlay.querySelector( '.hwf-close' ).addEventListener( 'click', () => overlay.remove() );
	overlay.addEventListener( 'click', ( e ) => { if ( e.target === overlay ) overlay.remove(); } );

}

// Soft radial-gradient glow texture (opaque center fading fully
// transparent at the edge) — used for the headlight halo so it looks
// like a real glow instead of a flat disc sitting on top of the lens.
function createGlowTexture( color ) {

	const size = 128;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	const grad = ctx.createRadialGradient( size / 2, size / 2, 0, size / 2, size / 2, size / 2 );
	grad.addColorStop( 0, `rgba(${ color }, 0.9)` );
	grad.addColorStop( 0.5, `rgba(${ color }, 0.35)` );
	grad.addColorStop( 1, `rgba(${ color }, 0)` );
	ctx.fillStyle = grad;
	ctx.fillRect( 0, 0, size, size );

	return new THREE.CanvasTexture( canvas );

}

// ─── Free-roam circuit environment (asphalt + grandstands) ──

function createAsphaltTexture() {

	const size = 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#232326';
	ctx.fillRect( 0, 0, size, size );

	for ( let i = 0; i < 1400; i ++ ) {

		const x = Math.random() * size, y = Math.random() * size;
		const v = 20 + Math.random() * 30;
		ctx.fillStyle = `rgba(${ v },${ v },${ v + 2 },${ 0.25 + Math.random() * 0.3 })`;
		ctx.fillRect( x, y, 1.4, 1.4 );

	}

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	return texture;

}

// Subtle grid of dashed lane-marking lines — gives visual reference
// points scattered across the open paved area, loosely evoking street
// lane markings (useful even with the barrier/stand dressing, since the
// middle of a large arena can still feel empty without them).
function createLaneMarkingsTexture() {

	const size = 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	ctx.strokeStyle = 'rgba(255,255,255,0.5)';
	ctx.lineWidth = 3;
	ctx.setLineDash( [ 14, 14 ] );
	ctx.beginPath();
	ctx.moveTo( size / 2, 0 );
	ctx.lineTo( size / 2, size );
	ctx.moveTo( 0, size / 2 );
	ctx.lineTo( size, size / 2 );
	ctx.stroke();

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	return texture;

}

function createSandTexture() {

	const size = 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#c9a877';
	ctx.fillRect( 0, 0, size, size );

	for ( let i = 0; i < 2200; i ++ ) {

		const x = Math.random() * size, y = Math.random() * size;
		const v = Math.random();
		const shade = v < 0.5 ? `rgba(150,120,80,${ 0.08 + Math.random() * 0.12 })` : `rgba(230,205,160,${ 0.08 + Math.random() * 0.15 })`;
		ctx.fillStyle = shade;
		ctx.fillRect( x, y, 1.6, 1.6 );

	}

	// Faint wind-ripple streaks
	ctx.strokeStyle = 'rgba(120,95,60,0.08)';
	ctx.lineWidth = 2;
	for ( let i = 0; i < 18; i ++ ) {

		const y = Math.random() * size;
		ctx.beginPath();
		ctx.moveTo( 0, y );
		ctx.bezierCurveTo( size * 0.3, y + ( Math.random() - 0.5 ) * 20, size * 0.7, y + ( Math.random() - 0.5 ) * 20, size, y );
		ctx.stroke();

	}

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	return texture;

}

// Large, non-repeating overlay of burnout circles and drift streaks laid
// once across the whole paved arena — a tiled texture would look
// obviously patterned at this scale, so this is drawn once at full size.
function createSkidMarksTexture( worldSize ) {

	const size = 1024;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );

	const toPx = ( w ) => ( w / worldSize + 0.5 ) * size;

	ctx.strokeStyle = 'rgba(10,10,12,0.35)';
	ctx.lineCap = 'round';

	// Burnout circles: paired concentric-ish rings with a slightly wobbly
	// radius, like a real donut/burnout mark.
	const circleCount = 7;
	for ( let c = 0; c < circleCount; c ++ ) {

		const cx = toPx( ( Math.random() - 0.5 ) * worldSize * 0.75 );
		const cy = toPx( ( Math.random() - 0.5 ) * worldSize * 0.75 );
		const r = size * ( 0.02 + Math.random() * 0.035 );

		for ( const offset of [ -3, 3 ] ) {

			ctx.lineWidth = 2.5 + Math.random() * 1.5;
			ctx.beginPath();
			const segs = 48;
			for ( let i = 0; i <= segs; i ++ ) {

				const a = ( i / segs ) * Math.PI * 2;
				const wob = Math.sin( a * 5 + c ) * r * 0.05;
				const px = cx + Math.cos( a ) * ( r + offset + wob );
				const py = cy + Math.sin( a ) * ( r + offset + wob );
				if ( i === 0 ) ctx.moveTo( px, py ); else ctx.lineTo( px, py );

			}

			ctx.stroke();

		}

	}

	// Long curved drift trails: pairs of near-parallel tracks following a
	// sweeping bezier path.
	const trailCount = 10;
	for ( let t = 0; t < trailCount; t ++ ) {

		const x0 = ( Math.random() - 0.5 ) * worldSize * 0.9;
		const y0 = ( Math.random() - 0.5 ) * worldSize * 0.9;
		const ang = Math.random() * Math.PI * 2;
		const len = worldSize * ( 0.15 + Math.random() * 0.25 );
		const bend = ( Math.random() - 0.5 ) * len * 0.6;

		const x1 = x0 + Math.cos( ang ) * len;
		const y1 = y0 + Math.sin( ang ) * len;
		const mx = ( x0 + x1 ) / 2 - Math.sin( ang ) * bend;
		const my = ( y0 + y1 ) / 2 + Math.cos( ang ) * bend;

		for ( const offset of [ -4, 4 ] ) {

			ctx.lineWidth = 3 + Math.random();
			ctx.globalAlpha = 0.5 + Math.random() * 0.3;
			ctx.beginPath();
			ctx.moveTo( toPx( x0 + Math.cos( ang + Math.PI / 2 ) * offset ), toPx( y0 + Math.sin( ang + Math.PI / 2 ) * offset ) );
			ctx.quadraticCurveTo(
				toPx( mx + Math.cos( ang + Math.PI / 2 ) * offset ), toPx( my + Math.sin( ang + Math.PI / 2 ) * offset ),
				toPx( x1 + Math.cos( ang + Math.PI / 2 ) * offset ), toPx( y1 + Math.sin( ang + Math.PI / 2 ) * offset )
			);
			ctx.stroke();

		}

	}
	ctx.globalAlpha = 1;

	const texture = new THREE.CanvasTexture( canvas );
	return texture;

}

function createCrowdTexture() {

	const w = 256, h = 64;
	const canvas = document.createElement( 'canvas' );
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#1c1f26';
	ctx.fillRect( 0, 0, w, h );

	const colors = [ '#e2725b', '#f2c230', '#4CAF6D', '#5B8CFF', '#f4f4f4', '#8B5FBF', '#D9534F' ];
	for ( let y = 6; y < h; y += 9 ) {

		const rowOffset = ( Math.round( y / 9 ) % 2 === 0 ) ? 4 : 8.5;
		for ( let x = rowOffset; x < w; x += 8.5 ) {

			ctx.fillStyle = colors[ Math.floor( Math.random() * colors.length ) ];
			ctx.beginPath();
			ctx.arc( x, y, 2.5, 0, Math.PI * 2 );
			ctx.fill();

		}

	}

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	return texture;

}

// Builds a 3-tier stepped grandstand (like Riyadh's Reem circuit) along
// one perimeter wall. axis 'x' = wall runs along X (north/south walls,
// fixedCoord is their Z); axis 'z' = wall runs along Z (east/west walls,
// fixedCoord is their X). direction (+1/-1) is which way it extends
// away from the track.
function buildGrandstandWall( scene, axis, length, fixedCoord, baseDistance, direction ) {

	// Many small rows (realistic stadium riser height, ~0.45m per step)
	// instead of a few huge tiers — each individual step should read as
	// smaller than the car, not towering over it.
	const rowHeight = 0.45, rowDepth = 1.3, numRows = 6;
	const tiers = [];
	for ( let i = 0; i < numRows; i ++ ) tiers.push( { h: rowHeight * ( i + 1 ), d: rowDepth } );
	let offset = 0;

	tiers.forEach( ( t ) => {

		const centerDist = baseDistance + offset + t.d / 2;
		const sizeX = axis === 'x' ? length : t.d;
		const sizeZ = axis === 'x' ? t.d : length;

		const texture = createCrowdTexture();
		texture.repeat.set( axis === 'x' ? length / 4 : 1,
			axis === 'x' ? 1 : length / 4 );

		const material = new THREE.MeshStandardMaterial( { map: texture, roughness: 1, metalness: 0 } );
		const mesh = new THREE.Mesh( new THREE.BoxGeometry( sizeX, t.h, sizeZ ), material );
		mesh.position.set(
			axis === 'x' ? 0 : fixedCoord + direction * centerDist,
			t.h / 2,
			axis === 'x' ? fixedCoord + direction * centerDist : 0
		);
		mesh.receiveShadow = true;
		scene.add( mesh );

		offset += t.d;

	} );

}

// Stadium floodlight pole: a tall mast + lamp head, with a real SpotLight
// aiming down at the track — matching the bright white floodlights over
// a real night "تفحيط" show.
function buildFloodlightPole( scene, x, z, aimTarget ) {

	const poleHeight = 9;
	const pole = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.12, 0.16, poleHeight, 8 ),
		new THREE.MeshStandardMaterial( { color: 0x3a3a3e, roughness: 0.7, metalness: 0.4 } )
	);
	pole.position.set( x, poleHeight / 2, z );
	pole.castShadow = true;
	scene.add( pole );

	// Small lamp head cluster at the top, tilted toward the track.
	const headGroup = new THREE.Group();
	headGroup.position.set( x, poleHeight - 0.1, z );
	headGroup.lookAt( aimTarget.x, 0, aimTarget.z );
	scene.add( headGroup );

	const headMat = new THREE.MeshStandardMaterial( { color: 0x111114, roughness: 0.5, metalness: 0.6 } );
	for ( let i = -1; i <= 1; i ++ ) {

		const lamp = new THREE.Mesh( new THREE.BoxGeometry( 0.5, 0.35, 0.15 ), headMat );
		lamp.position.set( i * 0.6, 0, 0.3 );
		lamp.rotation.x = -0.5;
		headGroup.add( lamp );

	}

	const light = new THREE.SpotLight( 0xf5f7ff, 25, 45, THREE.MathUtils.degToRad( 38 ), 0.4, 1.2 );
	light.position.set( x, poleHeight - 0.1, z );
	light.target.position.set( aimTarget.x, 0, aimTarget.z );
	light.castShadow = false; // 4 shadow-casting spotlights would be very expensive; dirLight still casts the car's shadow
	scene.add( light );
	scene.add( light.target );

}

// ─── Drift arena dressing: barriers, tire stacks, gate, signs ─

// Concrete jersey barrier segment: gray base + a painted orange/white
// hazard stripe near the top, the standard look for track-edge barriers.
function buildBarrierSegment( scene, world, x, z, length, axis ) {

	const h = 0.6, w = 0.35;
	const sizeX = axis === 'x' ? length : w;
	const sizeZ = axis === 'x' ? w : length;

	const body = new THREE.Mesh(
		new THREE.BoxGeometry( sizeX, h, sizeZ ),
		new THREE.MeshStandardMaterial( { color: 0x9a9a92, roughness: 0.95, metalness: 0 } )
	);
	body.position.set( x, h / 2, z );
	body.castShadow = true;
	body.receiveShadow = true;
	scene.add( body );

	const stripe = new THREE.Mesh(
		new THREE.BoxGeometry( axis === 'x' ? sizeX : sizeX * 1.02, 0.12, axis === 'x' ? sizeZ * 1.02 : sizeZ ),
		new THREE.MeshStandardMaterial( { color: 0xE0621B, roughness: 0.8 } )
	);
	stripe.position.set( x, h * 0.72, z );
	scene.add( stripe );

	if ( world ) {

		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ sizeX / 2, h / 2, sizeZ / 2 ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ x, h / 2 - 0.125, z ],
			friction: 0.3,
			restitution: 0.25,
		} );

	}

}

// A stack of tires (torus "tires", genuinely stacked) — decorative corner
// dressing, common at any real drift arena's edge.
function buildTireStack( scene, x, z, count ) {

	const tireMat = new THREE.MeshStandardMaterial( { color: 0x1c1c1e, roughness: 0.9, metalness: 0 } );
	let y = 0.12;

	for ( let i = 0; i < count; i ++ ) {

		const tire = new THREE.Mesh( new THREE.TorusGeometry( 0.35, 0.13, 10, 20 ), tireMat );
		tire.rotation.x = Math.PI / 2;
		tire.position.set( x + ( Math.random() - 0.5 ) * 0.04, y, z + ( Math.random() - 0.5 ) * 0.04 );
		tire.castShadow = true;
		tire.receiveShadow = true;
		scene.add( tire );
		y += 0.23;

	}

}

// Entrance gate: two pillars + a header beam, straddling one edge of the
// arena — purely a visual landmark (the barrier line behind it is still
// the actual boundary).
function buildEntranceGate( scene, x, z, axis ) {

	const pillarH = 4.2, pillarSize = 0.35, gap = 3.6;
	const mat = new THREE.MeshStandardMaterial( { color: 0x2c2c30, roughness: 0.6, metalness: 0.5 } );

	for ( const side of [ -1, 1 ] ) {

		const px = axis === 'x' ? x + side * gap / 2 : x;
		const pz = axis === 'x' ? z : z + side * gap / 2;
		const pillar = new THREE.Mesh( new THREE.BoxGeometry( pillarSize, pillarH, pillarSize ), mat );
		pillar.position.set( px, pillarH / 2, pz );
		pillar.castShadow = true;
		scene.add( pillar );

	}

	const beam = new THREE.Mesh(
		new THREE.BoxGeometry( axis === 'x' ? gap + pillarSize : pillarSize, 0.4, axis === 'x' ? pillarSize : gap + pillarSize ),
		mat
	);
	beam.position.set( x, pillarH + 0.2, z );
	beam.castShadow = true;
	scene.add( beam );

}

// Warning sign: yellow triangle on a post — no text/glyphs, just the
// hazard-triangle shape.
function buildWarningSign( scene, x, z, rotationY ) {

	const post = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.03, 0.03, 1.1, 6 ),
		new THREE.MeshStandardMaterial( { color: 0x333333, roughness: 0.7 } )
	);
	post.position.set( x, 0.55, z );
	scene.add( post );

	const shape = new THREE.Shape();
	shape.moveTo( 0, 0.32 );
	shape.lineTo( -0.28, -0.18 );
	shape.lineTo( 0.28, -0.18 );
	shape.closePath();

	const face = new THREE.Mesh(
		new THREE.ShapeGeometry( shape ),
		new THREE.MeshStandardMaterial( { color: 0xF2C230, roughness: 0.6, side: THREE.DoubleSide } )
	);
	const border = new THREE.Mesh(
		new THREE.RingGeometry( 0.26, 0.30, 3 ),
		new THREE.MeshStandardMaterial( { color: 0x1a1a1a, roughness: 0.6, side: THREE.DoubleSide } )
	);
	border.rotation.z = Math.PI; // point the ring-triangle the same way as the face

	const signGroup = new THREE.Group();
	signGroup.add( face );
	signGroup.add( border );
	signGroup.position.set( x, 1.15, z );
	signGroup.rotation.y = rotationY;
	scene.add( signGroup );

}

// ─── Custom windshield/tailgate text decal ─────────────────

function createTextTexture( text ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 512;
	canvas.height = 256;
	const ctx = canvas.getContext( '2d' );
	ctx.clearRect( 0, 0, 512, 256 );

	// Basic Arabic-range check so RTL text is drawn with correct direction;
	// canvas glyph shaping/joining works either way, this mainly affects
	// alignment when the string mixes scripts.
	if ( /[\u0600-\u06FF]/.test( text ) ) ctx.direction = 'rtl';

	ctx.font = 'bold 110px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.lineJoin = 'round';
	ctx.lineWidth = 10;
	ctx.strokeStyle = '#000000';
	ctx.strokeText( text, 256, 128 );
	ctx.fillStyle = '#ffffff';
	ctx.fillText( text, 256, 128 );

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;

}

// Adds the user's custom text on the windshield (facing forward) and the
// tailgate (facing backward), as children of the model's "body" node so
// they inherit its position/suspension-lean animation automatically.
// Coordinates match the pickup body built for this project (see the body
// mesh authored for vehicle-truck-yellow.glb) — purely cosmetic decals,
// no change to Vehicle.js or the model's own geometry.
function addCustomTextDecals( vehicleGroup, text ) {

	if ( ! text ) return;

	const vehicleModel = vehicleGroup.children[ 0 ];
	let bodyNode = null;
	vehicleModel.traverse( ( child ) => {

		if ( child.name.toLowerCase() === 'body' ) bodyNode = child;

	} );
	if ( ! bodyNode ) return;

	const texture = createTextTexture( text );
	const material = new THREE.MeshBasicMaterial( {
		// Single-sided on purpose: with DoubleSide, the front decal's
		// back face was visible (mirrored) from behind the vehicle over
		// the roofline, and vice versa for the rear decal. FrontSide
		// means each sticker only shows from its own correct side, like
		// a real decal.
		map: texture, transparent: true, depthWrite: false, side: THREE.FrontSide,
	} );

	// Coordinates measured directly from the actual shipped model's mesh
	// (vehicle-truck-*.glb — same body geometry across all 4 colors).
	// Windshield glass: center of mass (0, 0.42, 0.48), max z 0.548 —
	// decal sized to sit inside the glass panel itself (not the whole
	// frame) and offset just enough past the glass surface to avoid
	// z-fighting, like a sticker applied to the glass.
	const windshieldDecal = new THREE.Mesh( new THREE.PlaneGeometry( 0.62, 0.34 ), material );
	windshieldDecal.position.set( 0, 0.66, 0.57 );
	windshieldDecal.renderOrder = 10;
	bodyNode.add( windshieldDecal );

	// Rear window/panel: x:[-0.67,0.67] y:[0.09,0.5] z:[-1.4,-1.27].
	const tailgateDecal = new THREE.Mesh( new THREE.PlaneGeometry( 1.0, 0.5 ), material );
	tailgateDecal.position.set( 0, 0.28, -1.43 );
	tailgateDecal.rotation.y = Math.PI; // face backward
	tailgateDecal.renderOrder = 10;
	bodyNode.add( tailgateDecal );

}

// ─── Rear flag: pole-mounted, driver's-side corner ───────────
// Saudi Arabia drives left-hand-drive (driver's seat on the left), so
// "driver's side" = the vehicle's left = negative local x, matching the
// side=-1 convention already used for the taillights/reverse lights
// below. Mounted low, at rear-bumper/spare-tire height (not roof height)
// and near the left edge — matching a real full-size flag planted at the
// back of the vehicle, leaning up and outward, rather than a small
// roof-mounted pennant.
function addVehicleFlag( vehicleGroup, imageUrl ) {

	const vehicleModel = vehicleGroup.children[ 0 ];
	let bodyNode = null;
	vehicleModel.traverse( ( child ) => {

		if ( child.name.toLowerCase() === 'body' ) bodyNode = child;

	} );
	if ( ! bodyNode ) return null;

	const flag = createFlag( imageUrl );
	// Pole planted right at the rear bumper — pulled left (clear of the
	// bumper's width) and just past its depth, not floating away from it.
	flag.group.position.set( -0.6, 0.14, -1.36 );
	bodyNode.add( flag.group );

	return flag;

}

// ─── Real headlight / taillight lighting ───────────────────
// Coordinates measured directly from the model's actual headlight/
// taillight faces: left/right headlights at x:∓0.4, y:0.3, z:1.4;
// left/right taillights at x:∓0.4, y:0.43, z:-1.3. Attached to the
// same "body" node as the text decals, so they move and scale with
// the car (including the live resize control) automatically.
function addVehicleLights( vehicleGroup ) {

	const vehicleModel = vehicleGroup.children[ 0 ];
	let bodyNode = null;
	vehicleModel.traverse( ( child ) => {

		if ( child.name.toLowerCase() === 'body' ) bodyNode = child;

	} );
	if ( ! bodyNode ) return null;

	// Headlights: warm-white point lights, lighting up the real room
	// ahead in AR. Off by default — toggled by the player.
	// Mounted well above and ahead of the car (like a roof light bar)
	// instead of right at the bumper — being that close to the car's own
	// paint was overexposing/whiting-out the car itself (inverse-square
	// falloff means intensity right next to the source is extreme) while
	// barely reaching the room a couple meters out.
	// Headlights: warm-white spotlights, lighting up the real room ahead
	// in AR. Off by default — toggled by the player.
	// A PointLight mounted on the car always over-lit the car itself no
	// matter how far out it was pushed, since the car's own body is
	// rigidly attached nearby while the room is much farther — the car
	// dominates the illumination by inverse-square law regardless of
	// placement. Switched to a narrow directional SpotLight mounted
	// clear above the roof (not touching any geometry, unlike the first
	// SpotLight attempt) and aimed forward with a gentle downward tilt
	// calculated to clear the hood/roof entirely, so the beam only ever
	// hits the room, never the car's own body.
	const headlights = [];
	for ( const side of [ -1, 1 ] ) {

		const baseDistance = 14;
		const baseIntensity = 3000;
		const light = new THREE.SpotLight( 0xfff2cc, baseIntensity, baseDistance, Math.PI / 8, 0.35, 2 );
		const basePosition = new THREE.Vector3( side * 0.3, 1.05, 1.0 ); // clear above the roof, open air
		light.position.copy( basePosition );
		light.visible = false;

		const target = new THREE.Object3D();
		const baseTargetPosition = new THREE.Vector3( side * 0.3, 0.1, 9 ); // far ahead, gentle downward slope
		target.position.copy( baseTargetPosition );
		bodyNode.add( target );
		light.target = target;

		bodyNode.add( light );
		headlights.push( { light, target, basePosition, baseTargetPosition, baseDistance, baseIntensity } );

	}

	// Glowing "lens" overlays at the actual headlight bumps on the body
	// (measured earlier: x:∓0.4, y:~0.3, z:1.4) — separate from the
	// actual illuminating light above, which is roof-mounted so its beam
	// clears the car. This is purely visual: makes the headlight bump
	// itself look lit (bright white with a soft glow) when toggled on,
	// since the shared body material can't be selectively recolored
	// without touching the model file.
	const headlightLenses = [];
	for ( const side of [ -1, 1 ] ) {

		const group = new THREE.Group();
		const basePosition = new THREE.Vector3( side * 0.4, 0.3, 1.41 );
		group.position.copy( basePosition );
		group.userData.basePosition = basePosition;
		group.visible = false;

		const core = new THREE.Mesh(
			new THREE.CircleGeometry( 0.075, 16 ),
			new THREE.MeshBasicMaterial( { color: 0xffffff, toneMapped: false } )
		);
		group.add( core );

		const halo = new THREE.Mesh(
			new THREE.CircleGeometry( 0.16, 24 ),
			new THREE.MeshBasicMaterial( {
				map: createGlowTexture( '255, 242, 204' ), color: 0xfff2cc,
				transparent: true, toneMapped: false, depthWrite: false,
				blending: THREE.AdditiveBlending,
			} )
		);
		halo.position.z = -0.002; // just behind the core, avoids z-fighting
		group.add( halo );

		bodyNode.add( group );
		headlightLenses.push( group );

	}

	// Taillights: small, short-range red glow, always on — real
	// taillights don't meaningfully illuminate anything, this is just a
	// soft tint near the rear. (Kept at the same intensity that already
	// looked right — short range makes it visible even at low candela.)
	const taillights = [];
	for ( const side of [ -1, 1 ] ) {

		const baseDistance = 0.9;
		const baseIntensity = 0.8;
		const light = new THREE.PointLight( 0xff3b30, baseIntensity, baseDistance, 2 );
		const basePosition = new THREE.Vector3( side * 0.4, 0.43, -1.32 );
		light.position.copy( basePosition );
		bodyNode.add( light );
		taillights.push( { light, basePosition, baseDistance, baseIntensity } );

	}

	// Reverse (backup) lights: white glow at the rear, next to the
	// taillights, only lit while the car is actually reversing (driven
	// from linearSpeed < 0 in updateVehicleLights — no manual toggle,
	// same as a real car). Small lens glow like the headlight bumps —
	// intentionally subtle/small (a real backup light is a dim little
	// bulb, not a headlight-strength beam).
	const reverseLights = [];
	for ( const side of [ -1, 1 ] ) {

		const baseDistance = 0.8;
		const baseIntensity = 1.2;
		const light = new THREE.PointLight( 0xf5f9ff, baseIntensity, baseDistance, 2 );
		const basePosition = new THREE.Vector3( side * 0.25, 0.43, -1.34 );
		light.position.copy( basePosition );
		light.visible = false;
		bodyNode.add( light );

		const lens = new THREE.Mesh(
			new THREE.CircleGeometry( 0.035, 16 ),
			new THREE.MeshBasicMaterial( { color: 0xffffff, toneMapped: false } )
		);
		lens.position.copy( basePosition );
		lens.rotation.y = Math.PI; // face backward, out through the taillight bump
		lens.visible = false;
		bodyNode.add( lens );

		reverseLights.push( { light, lens, basePosition, baseDistance, baseIntensity } );

	}

	// Hazard/emergency lights: orange, blinking, at all 4 corners. Off
	// by default — toggled by the player, blink handled per-frame.
	const hazards = [];
	const hazardPositions = [
		[ -0.4, 0.3, 1.42 ], [ 0.4, 0.3, 1.42 ],
		[ -0.4, 0.43, -1.32 ], [ 0.4, 0.43, -1.32 ],
	];
	for ( const [ x, y, z ] of hazardPositions ) {

		const baseDistance = 0.8;
		const baseIntensity = 3;
		const light = new THREE.PointLight( 0xff8c1a, baseIntensity, baseDistance, 2 );
		const basePosition = new THREE.Vector3( x, y, z );
		light.position.copy( basePosition );
		light.visible = false;
		bodyNode.add( light );
		hazards.push( { light, basePosition, baseDistance, baseIntensity } );

	}

	return { headlights, taillights, hazards, headlightLenses, reverseLights };

}

// ─── Shared light control helpers (used by both modes) ─────

function toggleHeadlights( vehicleLights ) {

	if ( ! vehicleLights ) return;
	const on = ! vehicleLights.headlights[ 0 ].light.visible;
	vehicleLights.headlights.forEach( ( h ) => { h.light.visible = on; } );
	if ( vehicleLights.headlightLenses ) {

		vehicleLights.headlightLenses.forEach( ( lens ) => { lens.visible = on; } );

	}

}

function toggleHazards( vehicleLights ) {

	if ( ! vehicleLights ) return;
	vehicleLights.hazardsOn = ! vehicleLights.hazardsOn;
	if ( ! vehicleLights.hazardsOn ) {

		vehicleLights.hazards.forEach( ( h ) => { h.light.visible = false; } );

	}

}

// High beam is held, not toggled — while held, headlights go brighter
// and farther-reaching (and force ON even if the player hadn't turned
// regular headlights on, matching a real high-beam flasher stalk).
function setHighBeam( vehicleLights, on, scale = 1 ) {

	if ( ! vehicleLights ) return;
	if ( vehicleLights._highBeamOn === on ) return; // no change, skip

	if ( on ) vehicleLights._headlightsBeforeHighBeam = vehicleLights.headlights[ 0 ].light.visible;
	vehicleLights._highBeamOn = on;

	const s = Math.max( scale, 0.001 );

	vehicleLights.headlights.forEach( ( h ) => {

		if ( on ) {

			h.light.visible = true;
			h.light.intensity = h.baseIntensity * s * s * 2.5;
			h.light.distance = h.baseDistance * s * 1.4;

		} else {

			h.light.intensity = h.baseIntensity * s * s;
			h.light.distance = h.baseDistance * s;
			h.light.visible = vehicleLights._headlightsBeforeHighBeam;

		}

	} );

	if ( vehicleLights.headlightLenses ) {

		const lensOn = on || vehicleLights._headlightsBeforeHighBeam;
		vehicleLights.headlightLenses.forEach( ( lens ) => {

			lens.visible = lensOn;
			lens.scale.setScalar( on ? 1.3 : 1 );

		} );

	}

}

// Call every frame; handles the hazard blink timing and keeps light
// range proportional to the vehicle's current scale (AR resize control) —
// a light's `.distance` is in local units and does NOT automatically
// scale with its parent's transform the way position/rotation do.
function updateVehicleLights( vehicleLights, dt, scale, isReversing = false ) {

	if ( ! vehicleLights ) return;

	// Every light's distance/intensity scales with the vehicle size —
	// not just headlights. Taillights are always-on, so at AR-tabletop
	// scale an unscaled ~0.9m range dwarfed the entire shrunk track,
	// washing the whole scene in red. Distance scales linearly with
	// `scale` (so it's exactly baseDistance at scale=1, matching the
	// original tuning) and intensity scales with scale², following
	// inverse-square falloff so the illuminated patch looks like it
	// belongs to a light of that size.
	const s = Math.max( scale, 0.001 );

	if ( vehicleLights.headlights ) {

		vehicleLights.headlights.forEach( ( h ) => {

			h.light.distance = h.baseDistance * s;
			h.light.intensity = h.baseIntensity * s * s;

		} );

	}

	if ( vehicleLights.taillights ) {

		vehicleLights.taillights.forEach( ( t ) => {

			t.light.distance = t.baseDistance * s;
			t.light.intensity = t.baseIntensity * s * s;

		} );

	}

	if ( vehicleLights.hazards ) {

		vehicleLights.hazards.forEach( ( h ) => {

			h.light.distance = h.baseDistance * s;
			h.light.intensity = h.baseIntensity * s * s;

		} );

	}

	if ( vehicleLights.reverseLights ) {

		vehicleLights.reverseLights.forEach( ( r ) => {

			r.light.distance = r.baseDistance * s;
			r.light.intensity = r.baseIntensity * s * s;
			r.light.visible = isReversing;
			if ( r.lens ) r.lens.visible = isReversing;

		} );

	}

	if ( vehicleLights.hazardsOn ) {

		vehicleLights._blinkTimer = ( vehicleLights._blinkTimer || 0 ) + dt;
		const on = Math.floor( vehicleLights._blinkTimer / 0.4 ) % 2 === 0;
		vehicleLights.hazards.forEach( ( h ) => { h.light.visible = on; } );

	}

}

// ─── Race countdown ─────────────────────────────────────────

// TEMPORARY diagnostic helper — flashes a short-lived note in the
// corner of the screen. Used to get definitive visual proof the AI
// stuck-recovery watchdog actually fires (console.warn alone isn't
// visible on a phone). Safe to remove once the AI driving issue is
// confirmed fixed.
function flashDebugNote( text ) {

	const el = document.createElement( 'div' );
	el.textContent = text;
	el.style.cssText = `
		position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 80;
		background: rgba(20,10,30,0.85); color: #fff; padding: 8px 16px; border-radius: 10px;
		font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 13px; direction: rtl;
		border: 1px solid rgba(139,95,191,0.5);
	`;
	document.body.appendChild( el );
	setTimeout( () => el.remove(), 2500 );

}

function createCountdownUI() {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-countdown {
			position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
			pointer-events: none;
		}
		#hw-countdown .cd-num {
			font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 120px; font-weight: 800; color: #fff;
			text-shadow: 0 0 30px rgba(91,140,255,0.8), 0 4px 12px rgba(0,0,0,0.6);
		}
	`;
	document.head.appendChild( style );

	const el = document.createElement( 'div' );
	el.id = 'hw-countdown';
	el.innerHTML = '<div class="cd-num"></div>';
	document.body.appendChild( el );

	return {
		numEl: el.querySelector( '.cd-num' ),
		set( text ) {

			this.numEl.textContent = text;
			this.numEl.animate(
				[ { transform: 'scale(1.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 } ],
				{ duration: 280, easing: 'ease-out' }
			);

		},
		remove() { el.remove(); },
	};

}

// ─── Touch radio controls (phones/tablets — no keyboard, no VR hands) ──
// Controls.js already covers a full-screen invisible steering zone for
// touch, so these buttons need a higher z-index to receive taps first.

function setupRadioTouchUI( radio, vehicleLights ) {

	if ( ! ( 'ontouchstart' in window ) ) return { highBeamHeld: false };

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-touch-dock {
			position: fixed; left: 14px; bottom: 14px; z-index: 30;
			display: flex; flex-direction: column; gap: 8px;
			padding: 10px 8px; border-radius: 20px;
			background: linear-gradient(165deg, rgba(32,20,54,0.72), rgba(13,13,22,0.72));
			border: 1px solid rgba(139,95,191,0.35);
			backdrop-filter: blur(6px);
			box-shadow: 0 6px 24px rgba(0,0,0,0.4);
		}
		#hw-touch-dock button {
			width: 50px; height: 50px; border-radius: 50%; border: none; padding: 0;
			background: rgba(255,255,255,0.06); color: #fff; font-size: 21px;
			display: flex; align-items: center; justify-content: center;
			touch-action: manipulation; transition: background 0.12s, transform 0.08s;
		}
		#hw-touch-dock button:active {
			background: linear-gradient(135deg, #8B5FBF, #5B8CFF);
			transform: scale(0.94);
		}
	`;
	document.head.appendChild( style );

	const wrap = document.createElement( 'div' );
	wrap.id = 'hw-touch-dock';

	function makeTapButton( label ) {

		const btn = document.createElement( 'button' );
		btn.textContent = label;
		return btn;

	}

	const nextBtn = makeTapButton( '⏭' );
	const toggleBtn = makeTapButton( '⏯' );
	const headlightBtn = makeTapButton( '💡' );
	const hazardBtn = makeTapButton( '⚠️' );
	const highBeamBtn = makeTapButton( '🔆' );

	// pointerdown (not click) for lower latency and to match the steering
	// zone's own event type; stopPropagation so the tap doesn't also get
	// picked up as a steering-zone touch.
	nextBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		radio.next();

	} );
	toggleBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		radio.togglePlayPause();

	} );
	headlightBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		toggleHeadlights( vehicleLights );

	} );
	hazardBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		toggleHazards( vehicleLights );

	} );

	// High beam is a hold, not a tap — on while pressed, off on release.
	// Sets a flag rather than calling setHighBeam() directly: the
	// keyboard's own per-frame check (N key) was calling setHighBeam()
	// unconditionally every frame regardless of source, so on a
	// touch-only device (no keyboard) that per-frame call was always
	// "off" and immediately canceled whatever this button had just
	// turned on. The frame loop now combines both sources before calling
	// setHighBeam() once.
	const touchState = { highBeamHeld: false };
	highBeamBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		touchState.highBeamHeld = true;

	} );
	[ 'pointerup', 'pointerleave', 'pointercancel' ].forEach( ( evt ) => {

		highBeamBtn.addEventListener( evt, ( e ) => {

			e.stopPropagation();
			touchState.highBeamHeld = false;

		} );

	} );

	wrap.appendChild( nextBtn );
	wrap.appendChild( toggleBtn );
	wrap.appendChild( headlightBtn );
	wrap.appendChild( hazardBtn );
	wrap.appendChild( highBeamBtn );
	document.body.appendChild( wrap );

	return touchState;

}

// ─── Shared physics world setup (used by both modes) ──────

function createPhysicsWorld( gravityScale = 1 ) {

	const worldSettings = createWorldSettings();
	worldSettings.gravity = [ 0, - 9.81 * gravityScale, 0 ];

	const BPL_MOVING = addBroadphaseLayer( worldSettings );
	const BPL_STATIC = addBroadphaseLayer( worldSettings );
	const OL_MOVING = addObjectLayer( worldSettings, BPL_MOVING );
	const OL_STATIC = addObjectLayer( worldSettings, BPL_STATIC );

	enableCollision( worldSettings, OL_MOVING, OL_STATIC );
	enableCollision( worldSettings, OL_MOVING, OL_MOVING );

	const world = createWorld( worldSettings );
	world._OL_MOVING = OL_MOVING;
	world._OL_STATIC = OL_STATIC;

	return world;

}

// ─── Shared per-frame driving/game-object update, used by ──
// ─── both NORMAL and AR modes once a vehicle exists.       ──

function updateVehicleAndFx( dt, input, ctx ) {

	const { world, vehicle, particles, driftMarks, audio, lapTimer, contactListener, vehicleFlag } = ctx;

	updateWorld( world, contactListener, dt );
	vehicle.update( dt, input );

	particles.update( dt, vehicle );
	driftMarks.update( dt, vehicle );
	audio.update( dt, vehicle.linearSpeed / MAX_SPEED, input.z, vehicle.driftIntensity, vehicle.linearSpeed < -0.01 );
	if ( vehicle.justLaunched ) audio.playLaunch();
	if ( vehicleFlag ) vehicleFlag.updateFlutter( dt, Math.abs( vehicle.linearSpeed / MAX_SPEED ) );

	if ( lapTimer ) {

		const hasInput = input.touchActive || Math.abs( input.x ) > 0.05 || Math.abs( input.z ) > 0.05;
		lapTimer.update( dt, vehicle.spherePos, hasInput );

	}

}

// ─── AI opponents (real Vehicle physics, same as the player) ──
// Each AI gets its own Vehicle + sphere rigid body — the exact same
// class and physics the player drives with (sphere collider, suspension
// lean, wheel spin, drift). Steering/throttle are computed each frame
// from the direction to the next waypoint and fed in using the same
// "touch" input shape the game already uses for world-space-direction
// joystick control (see Controls.js/Vehicle.js), so movement quality
// matches the player's car and auto-gas naturally targets MAX_SPEED —
// giving genuinely competitive AI without extra speed tuning.

const TOTAL_RACE_LAPS = 3; // matches LapTimer.js's own TOTAL_LAPS

// Computes a 2-wide staggered starting grid behind the finish line —
// slot 0 is the player (front-left), slots 1+ are AI opponents.
function computeGridPositions( vehicleSpawn, count ) {

	const { position, angle } = vehicleSpawn;
	// Flipped relative to angle's raw sin/cos — matches the same
	// correction applied in Track.js's computeTrackPath, verified
	// against actual gameplay direction.
	const forward = { x: - Math.sin( angle ), z: - Math.cos( angle ) };
	const right = { x: forward.z, z: - forward.x };
	const rowSpacing = 3.2, colOffset = 0.8;

	const slots = [];
	for ( let i = 0; i < count; i ++ ) {

		const row = Math.floor( i / 2 );
		const col = ( i % 2 === 0 ) ? -1 : 1;
		const backDist = 2 + row * rowSpacing;

		const x = position[ 0 ] - forward.x * backDist + right.x * col * colOffset;
		const z = position[ 2 ] - forward.z * backDist + right.z * col * colOffset;

		slots.push( { position: [ x, position[ 1 ], z ], angle, backDist } );

	}

	return slots;

}

function createAIDrivers( npcConfigs, gridSlots, models, scene, world, path, radius = 0.5 ) {

	if ( ! path || path.length < 2 ) return [];

	// Average spacing between consecutive path points — used to convert
	// each grid slot's "how far back from the line" distance directly
	// into a starting path index, counting backward from index 0 (the
	// finish line). This avoids a plain nearest-point spatial search,
	// which could pick a point on the wrong side of the loop where the
	// start and end come back close together near the finish line,
	// sending that car off in the wrong direction from the start.
	let totalLen = 0;
	for ( let j = 0; j < path.length; j ++ ) {

		const a = path[ j ], b = path[ ( j + 1 ) % path.length ];
		totalLen += Math.hypot( b.x - a.x, b.z - a.z );

	}
	const avgSpacing = totalLen / path.length;

	return npcConfigs.map( ( cfg, i ) => {

		const slot = gridSlots[ i + 1 ]; // slot 0 is the player
		const sphereBody = createSphereBody( world, slot.position, radius );

		const vehicle = new Vehicle();
		vehicle.sphereRadius = radius;
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spherePos.set( slot.position[ 0 ], slot.position[ 1 ], slot.position[ 2 ] );
		vehicle.prevModelPos.set( slot.position[ 0 ], 0, slot.position[ 2 ] );
		vehicle.container.rotation.y = slot.angle;

		const model = models[ cfg.key ] || models[ 'vehicle-truck-yellow' ];
		const group = vehicle.init( model );
		group.scale.setScalar( radius / 0.5 ); // matches the player's own visual scale — 1 for NORMAL mode (radius=0.5), shrunk in AR contexts
		scene.add( group );

		const stepsBack = Math.round( slot.backDist / avgSpacing );
		const bestIdx = ( ( path.length - stepsBack ) % path.length + path.length ) % path.length;

		return {
			vehicle, idx: bestIdx,
			lapsCompleted: 0,
			finished: false,
			finishTime: null,
			stuckStrikes: 0,
			sampleTimer: 0,
			samplePos: { x: slot.position[ 0 ], z: slot.position[ 2 ] },
		};

	} );

}

// ─── Free-roam AI (random wandering "تفحيط" show, no fixed path) ──
// Unlike the race AI above, these don't follow a track — they just pick
// a random point inside the open arena, drive at it aggressively (full
// throttle, no easing off for the turn — the opposite of the race AI's
// cornering behavior), and pick a new random point every few seconds.
// The sharp steering at speed naturally induces the same drift the
// player's own car gets from Vehicle.js's physics, giving a "تفحيط
// show" look. No collision avoidance — bumping the boundary wall or
// another car is fine, even expected, for this look.

function createFreeRoamAI( npcConfigs, models, scene, world, roadHalf ) {

	const spawnMargin = roadHalf * 0.5; // keep starting points away from the walls

	return npcConfigs.map( ( cfg, i ) => {

		const angle = ( i / npcConfigs.length ) * Math.PI * 2;
		const dist = spawnMargin * ( 0.4 + Math.random() * 0.5 );
		const x = Math.cos( angle ) * dist;
		const z = Math.sin( angle ) * dist;
		const heading = Math.random() * Math.PI * 2;

		const sphereBody = createSphereBody( world, [ x, 0.5, z ] );

		const vehicle = new Vehicle();
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spherePos.set( x, 0.5, z );
		vehicle.prevModelPos.set( x, 0, z );
		vehicle.container.rotation.y = heading;

		const model = models[ cfg.key ] || models[ 'vehicle-truck-yellow' ];
		const group = vehicle.init( model );
		scene.add( group );

		return {
			vehicle,
			target: { x, z }, // reached immediately, forces a fresh pick on frame 1
			retargetTimer: 0,
			stuckStrikes: 0,
			sampleTimer: 0,
			samplePos: { x, z },
		};

	} );

}

function updateFreeRoamAI( drivers, dt, roadHalf ) {

	// Kept well inside the boundary wall (and the grandstands beyond
	// it) — the wander target itself never gets close to the wall, and
	// current-position is checked every frame as a second safety net so
	// speed/drift momentum carrying a car past its target can't send it
	// into the wall either.
	const wanderRadius = roadHalf * 0.45;
	const pullBackRadius = roadHalf * 0.6;

	for ( const d of drivers ) {

		// Same stuck watchdog as the race AI: if genuinely wedged
		// against a wall (steering back toward center alone can't
		// always recover from a bad angle), teleport back to a safe
		// spot near the middle rather than leaving it stuck.
		d.sampleTimer += dt;
		if ( d.sampleTimer >= 0.5 ) {

			d.sampleTimer = 0;
			const progressed = Math.hypot(
				d.vehicle.spherePos.x - d.samplePos.x,
				d.vehicle.spherePos.z - d.samplePos.z
			);
			d.samplePos = { x: d.vehicle.spherePos.x, z: d.vehicle.spherePos.z };
			if ( progressed < 0.4 ) d.stuckStrikes += 1; else d.stuckStrikes = 0;

		}

		if ( d.stuckStrikes >= 3 ) {

			const a = Math.random() * Math.PI * 2;
			const r = Math.random() * wanderRadius * 0.4;
			const p = { x: Math.cos( a ) * r, z: Math.sin( a ) * r };
			const heading = Math.random() * Math.PI * 2;

			rigidBody.setPosition( d.vehicle.physicsWorld, d.vehicle.rigidBody, [ p.x, 0.5, p.z ], false );
			rigidBody.setLinearVelocity( d.vehicle.physicsWorld, d.vehicle.rigidBody, [ 0, 0, 0 ] );
			rigidBody.setAngularVelocity( d.vehicle.physicsWorld, d.vehicle.rigidBody, [ 0, 0, 0 ] );
			d.vehicle.spherePos.set( p.x, 0.5, p.z );
			d.vehicle.sphereVel.set( 0, 0, 0 );
			d.vehicle.container.position.set( p.x, 0, p.z );
			d.vehicle.container.rotation.set( 0, heading, 0 );
			d.vehicle.linearSpeed = 0;
			d.vehicle.angularSpeed = 0;
			d.vehicle.acceleration = 0;

			d.target = { x: p.x, z: p.z };
			d.retargetTimer = 0;
			d.stuckStrikes = 0;
			d.sampleTimer = 0;
			d.samplePos = { x: p.x, z: p.z };
			continue;

		}

		d.retargetTimer -= dt;

		const distFromCenter = Math.hypot( d.vehicle.spherePos.x, d.vehicle.spherePos.z );
		const dx0 = d.target.x - d.vehicle.spherePos.x, dz0 = d.target.z - d.vehicle.spherePos.z;
		const distToTarget = Math.hypot( dx0, dz0 );

		if ( distFromCenter > pullBackRadius ) {

			// Too close to the wall/grandstands right now — override
			// whatever the current target was and head straight back
			// toward the middle immediately, ignoring the normal timer.
			d.target = { x: 0, z: 0 };
			d.retargetTimer = 2 + Math.random() * 3;

		} else if ( d.retargetTimer <= 0 || distToTarget < 3 ) {

			const a = Math.random() * Math.PI * 2;
			const r = Math.random() * wanderRadius;
			d.target = { x: Math.cos( a ) * r, z: Math.sin( a ) * r };
			d.retargetTimer = 2 + Math.random() * 3; // new target every 2-5s even if not reached

		}

		const dx = d.target.x - d.vehicle.spherePos.x, dz = d.target.z - d.vehicle.spherePos.z;
		const dist = Math.hypot( dx, dz );

		const input = { x: 0, z: 1, touchActive: false }; // always full throttle — no easing off for turns, unlike the race AI

		if ( dist > 0.001 ) {

			const carAngle = d.vehicle.container.rotation.y;
			const targetAngle = Math.atan2( dx, dz );
			let angleDiff = targetAngle - carAngle;
			angleDiff = ( ( angleDiff + Math.PI ) % ( Math.PI * 2 ) ) - Math.PI;

			// Higher gain than the race AI on purpose — snappier, more
			// aggressive direction changes at speed are exactly what
			// triggers Vehicle.js's own drift physics.
			input.x = THREE.MathUtils.clamp( angleDiff * 3.5, -1, 1 );

		}

		d.vehicle.update( dt, input );

	}

}

function updateAIDrivers( drivers, path, dt, racing, totalTime ) {

	if ( ! path || path.length < 2 ) return;

	const LOOKAHEAD = 2; // waypoints ahead to steer toward — reduced from 4, which was cutting corners wide enough to sometimes clip off-track decoration
	const MAX_DRIFT = 4; // if further than this from the path, force a resync instead of continuing to compound the error

	for ( const d of drivers ) {

		const input = { x: 0, z: 0, touchActive: false };

		if ( racing && ! d.finished ) {

			// Stuck watchdog: if a car hasn't made real progress over
			// several half-second samples (wedged against a wall at a
			// bad angle, etc.), steering alone might never recover it —
			// decorations have no collider, but the track's own
			// boundary/corner walls do. Sampling every 0.5s (instead of
			// checking every single frame) avoids a false reset from
			// small physics jitter/vibration while genuinely wedged
			// against something — a per-frame check kept getting reset
			// by that jitter and never actually reaching the threshold.
			d.sampleTimer += dt;
			if ( d.sampleTimer >= 0.5 ) {

				d.sampleTimer = 0;
				const progressed = Math.hypot(
					d.vehicle.spherePos.x - d.samplePos.x,
					d.vehicle.spherePos.z - d.samplePos.z
				);
				d.samplePos = { x: d.vehicle.spherePos.x, z: d.vehicle.spherePos.z };

				if ( progressed < 0.4 ) d.stuckStrikes += 1; else d.stuckStrikes = 0;

			}

			if ( d.stuckStrikes >= 3 ) { // ~1.5s of near-zero net movement

				console.warn( '[AI] stuck-recovery triggered for a driver, resyncing to path' );

				let bestJ = d.idx, bestD = Infinity;
				for ( let j = 0; j < path.length; j ++ ) {

					const ddx = path[ j ].x - d.vehicle.spherePos.x, ddz = path[ j ].z - d.vehicle.spherePos.z;
					const dd = ddx * ddx + ddz * ddz;
					if ( dd < bestD ) { bestD = dd; bestJ = j; }

				}
				d.idx = bestJ;
				const p = path[ bestJ ], pNext = path[ ( bestJ + 1 ) % path.length ];
				const heading = Math.atan2( pNext.x - p.x, pNext.z - p.z );

				rigidBody.setPosition( d.vehicle.physicsWorld, d.vehicle.rigidBody, [ p.x, 0.5, p.z ], false );
				rigidBody.setLinearVelocity( d.vehicle.physicsWorld, d.vehicle.rigidBody, [ 0, 0, 0 ] );
				rigidBody.setAngularVelocity( d.vehicle.physicsWorld, d.vehicle.rigidBody, [ 0, 0, 0 ] );
				d.vehicle.spherePos.set( p.x, 0.5, p.z );
				d.vehicle.sphereVel.set( 0, 0, 0 );
				d.vehicle.container.position.set( p.x, 0, p.z );
				d.vehicle.container.rotation.set( 0, heading, 0 );
				d.vehicle.linearSpeed = 0;
				d.vehicle.angularSpeed = 0;
				d.vehicle.acceleration = 0;

				d.stuckStrikes = 0;
				d.sampleTimer = 0;
				d.samplePos = { x: p.x, z: p.z };

			}

			const target = path[ ( d.idx + 1 ) % path.length ];
			const dx0 = target.x - d.vehicle.spherePos.x, dz0 = target.z - d.vehicle.spherePos.z;
			const distToNext = Math.hypot( dx0, dz0 );

			if ( distToNext < 1.0 ) {

				d.idx = ( d.idx + 1 ) % path.length;
				if ( d.idx === 0 ) {

					d.lapsCompleted += 1;
					if ( d.lapsCompleted >= TOTAL_RACE_LAPS ) { d.finished = true; d.finishTime = totalTime; }

				}

			} else if ( distToNext > MAX_DRIFT ) {

				// Drifted too far off course (e.g. clipped a decoration
				// piece and got deflected) — instead of continuing to
				// chase an increasingly wrong target, snap to whichever
				// path point is actually closest right now.
				let bestJ = d.idx, bestD = Infinity;
				for ( let j = 0; j < path.length; j ++ ) {

					const ddx = path[ j ].x - d.vehicle.spherePos.x, ddz = path[ j ].z - d.vehicle.spherePos.z;
					const dd = ddx * ddx + ddz * ddz;
					if ( dd < bestD ) { bestD = dd; bestJ = j; }

				}
				d.idx = bestJ;

			}

			// Steer toward a point further down the path (not just the
			// very next waypoint) so the car starts turning-in before a
			// corner instead of reacting only once right on top of it —
			// same idea as a real driver looking ahead through a turn.
			const lookaheadPoint = path[ ( d.idx + LOOKAHEAD ) % path.length ];
			const dx = lookaheadPoint.x - d.vehicle.spherePos.x, dz = lookaheadPoint.z - d.vehicle.spherePos.z;
			const dist = Math.hypot( dx, dz );

			if ( dist > 0.001 ) {

				const carAngle = d.vehicle.container.rotation.y;
				const targetAngle = Math.atan2( dx, dz );
				let angleDiff = targetAngle - carAngle;
				angleDiff = ( ( angleDiff + Math.PI ) % ( Math.PI * 2 ) ) - Math.PI;

				// Proper steering-wheel input (same code path the
				// keyboard uses) instead of the touch mode's instant
				// slerp-to-direction — that was rotating the visible
				// model straight at the target every frame while the
				// physics body kept its old momentum, so the car looked
				// like it was spinning out at every turn.
				input.x = THREE.MathUtils.clamp( angleDiff * 2, -1, 1 );
				input.touchActive = false;

				// Ease off the throttle for sharp turns, like a real
				// driver braking before a corner instead of charging in
				// at full speed and losing grip.
				const sharpness = THREE.MathUtils.clamp( Math.abs( angleDiff ) / ( Math.PI / 3 ), 0, 1 );
				input.z = 1 - sharpness * 0.5;

			}

		}

		d.vehicle.update( dt, input );

	}

}

// Ranks player + AI by laps completed (then in-lap progress as a
// tiebreak) — used once the player finishes to produce final standings.
function computeStandings( drivers, path, playerFinishTime ) {

	const entries = [ {
		label: 'أنت', isPlayer: true,
		metric: TOTAL_RACE_LAPS,
		finishTime: playerFinishTime,
	} ];

	drivers.forEach( ( d, i ) => {

		const progress = path && path.length > 1 ? d.idx / path.length : 0;
		entries.push( {
			label: 'الحاسوب ' + ( i + 1 ), isPlayer: false,
			metric: d.lapsCompleted + progress,
			finishTime: d.finishTime,
		} );

	} );

	entries.sort( ( a, b ) => {

		if ( a.finishTime !== null && b.finishTime !== null ) return a.finishTime - b.finishTime;
		if ( a.finishTime !== null ) return -1;
		if ( b.finishTime !== null ) return 1;
		return b.metric - a.metric;

	} );

	return entries;

}

function showRaceResultsOverlay( standings, { onRestart, onMenu } ) {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-race-results {
			position: fixed; inset: 0; z-index: 55; display: flex; align-items: center; justify-content: center;
			background: rgba(5,5,10,0.78); font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
		}
		#hw-race-results .rr-card {
			max-width: 400px; width: 90%; padding: 28px 24px; border-radius: 20px; text-align: center;
			background: radial-gradient(circle at 50% 0%, #201436 0%, #0d0d16 70%);
			border: 1px solid rgba(139,95,191,0.4); box-shadow: 0 0 50px rgba(91,60,140,0.25);
		}
		#hw-race-results .rr-title {
			font-size: 26px; font-weight: 800; margin-bottom: 18px;
			background: linear-gradient(90deg, #8B5FBF 0%, #5B8CFF 50%, #4FD8E8 100%);
			-webkit-background-clip: text; background-clip: text; color: transparent;
		}
		#hw-race-results .rr-row {
			display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-top: 1px solid rgba(255,255,255,0.08);
		}
		#hw-race-results .rr-row:first-of-type { border-top: none; }
		#hw-race-results .rr-pos { width: 26px; font-weight: 800; color: #9d8fd4; }
		#hw-race-results .rr-label { flex: 1; text-align: right; color: #fff; font-size: 14.5px; }
		#hw-race-results .rr-row.rr-me .rr-label { color: #5B8CFF; font-weight: 700; }
		#hw-race-results .rr-btns { display: flex; gap: 10px; margin-top: 20px; }
		#hw-race-results button {
			flex: 1; padding: 13px; border: none; border-radius: 999px; font-size: 14.5px; font-weight: 600; cursor: pointer;
		}
		#hw-race-results .rr-restart { background: linear-gradient(90deg, #8B5FBF, #5B8CFF); color: #fff; }
		#hw-race-results .rr-menu { background: rgba(255,255,255,0.08); color: #cfc9e0; }
	`;
	document.head.appendChild( style );

	const overlay = document.createElement( 'div' );
	overlay.id = 'hw-race-results';
	overlay.dir = 'rtl';
	overlay.innerHTML = `
		<div class="rr-card">
			<div class="rr-title">🏁 نتيجة السباق</div>
			${ standings.map( ( s, i ) => `
				<div class="rr-row ${ s.isPlayer ? 'rr-me' : '' }">
					<div class="rr-pos">${ i + 1 }</div>
					<div class="rr-label">${ s.label }</div>
				</div>
			` ).join( '' ) }
			<div class="rr-btns">
				<button class="rr-restart">إعادة السباق</button>
				<button class="rr-menu">الصفحة الرئيسية</button>
			</div>
		</div>
	`;
	document.body.appendChild( overlay );

	overlay.querySelector( '.rr-restart' ).addEventListener( 'click', () => { overlay.remove(); onRestart(); } );
	overlay.querySelector( '.rr-menu' ).addEventListener( 'click', () => { overlay.remove(); onMenu(); } );

}

// ─── NORMAL MODE (unchanged behavior from the original game) ──

function startNormalMode( { customCells, spawn, mapParam, customText, freeRoam, vehicleKey, flagImage } ) {

	const world = createPhysicsWorld();
	let sphereBody, vehicleSpawn, lapTimer = null;
	let trackPath = null, aiDrivers = [];
	let freeRoamHalf = 0;

	if ( freeRoam ) {

		// Open sandbox: no track, no walls — just a big flat ground.
		const groundSize = 110;

		// Night stadium look (matching a real "تفحيط" show — dark sky,
		// the floodlight poles below doing the actual lighting instead of
		// flat daylight). Scoped to free-roam only; the classic track
		// mode keeps its normal daylight scene.
		scene.background = new THREE.Color( 0x05060a );
		scene.fog.color.set( 0x05060a );
		dirLight.intensity = 0.4; // faint moonlight fill, floodlights carry the scene
		hemiLight.intensity = 0.35;

		const roadHalf = groundSize / 2;

		const shadowExtent = roadHalf;
		dirLight.shadow.camera.left = - shadowExtent;
		dirLight.shadow.camera.right = shadowExtent;
		dirLight.shadow.camera.top = shadowExtent;
		dirLight.shadow.camera.bottom = - shadowExtent;
		dirLight.shadow.camera.updateProjectionMatrix();

		scene.fog.near = groundSize * 0.5;
		scene.fog.far = groundSize * 1.1;

		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ 0, - 0.125, 0 ],
			friction: 5.0,
			restitution: 0.0,
		} );

		// Visible asphalt ground, matching the invisible physics floor.
		const asphaltTexture = createAsphaltTexture();
		asphaltTexture.repeat.set( groundSize / 8, groundSize / 8 );
		const groundMesh = new THREE.Mesh(
			new THREE.PlaneGeometry( groundSize, groundSize ),
			new THREE.MeshStandardMaterial( { map: asphaltTexture, roughness: 1, metalness: 0 } )
		);
		groundMesh.rotation.x = - Math.PI / 2;
		groundMesh.position.set( 0, - 0.12, 0 );
		groundMesh.receiveShadow = true;
		scene.add( groundMesh );

		// Solid perimeter walls so the car bounces off the edge instead of
		// driving past it and falling into the void — now with visible
		// grandstands (crowd included, Reem-circuit style) instead of an
		// invisible boundary.
		const wallHalfHeight = 1.0;
		const wallThickness = 0.2;
		const wallY = - 0.125 + wallHalfHeight;

		for ( const sign of [ 1, -1 ] ) {

			rigidBody.create( world, { // north/south (along X)
				shape: box.create( { halfExtents: [ roadHalf, wallHalfHeight, wallThickness ] } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ 0, wallY, sign * roadHalf ],
				friction: 0.2,
				restitution: 0.3,
			} );

			rigidBody.create( world, { // east/west (along Z)
				shape: box.create( { halfExtents: [ wallThickness, wallHalfHeight, roadHalf ] } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ sign * roadHalf, wallY, 0 ],
				friction: 0.2,
				restitution: 0.3,
			} );

			buildGrandstandWall( scene, 'x', roadHalf * 2, sign * roadHalf, wallThickness, sign );
			buildGrandstandWall( scene, 'z', roadHalf * 2, sign * roadHalf, wallThickness, sign );

		}

		// Floodlight poles at the four corners, all aimed back at center —
		// the actual light source for the night-stadium look set above.
		const poleInset = roadHalf * 0.82;
		for ( const cx of [ -1, 1 ] ) {

			for ( const cz of [ -1, 1 ] ) {

				buildFloodlightPole( scene, cx * poleInset, cz * poleInset, { x: 0, z: 0 } );

			}

		}

		// Dry desert surround, peeking out beyond the paved arena's edge —
		// sits just below the asphalt so it only shows past its footprint.
		const sandTexture = createSandTexture();
		const sandSize = groundSize * 2;
		sandTexture.repeat.set( sandSize / 10, sandSize / 10 );
		const sandMesh = new THREE.Mesh(
			new THREE.PlaneGeometry( sandSize, sandSize ),
			new THREE.MeshStandardMaterial( { map: sandTexture, roughness: 1, metalness: 0 } )
		);
		sandMesh.rotation.x = - Math.PI / 2;
		sandMesh.position.set( 0, - 0.121, 0 );
		sandMesh.receiveShadow = true;
		scene.add( sandMesh );

		// Burnout circles + drift trails, baked once across the whole
		// paved surface — a proper tiled texture would look obviously
		// repeated at this scale.
		const skidMarksTexture = createSkidMarksTexture( groundSize );
		const skidOverlay = new THREE.Mesh(
			new THREE.PlaneGeometry( groundSize, groundSize ),
			new THREE.MeshStandardMaterial( {
				map: skidMarksTexture, transparent: true, roughness: 1,
				metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
			} )
		);
		skidOverlay.rotation.x = - Math.PI / 2;
		skidOverlay.position.set( 0, - 0.1195, 0 );
		scene.add( skidOverlay );

		// Concrete barriers dressing the same line as the invisible
		// collision walls above (no extra physics needed — the collider's
		// already there). One gap left open on the +Z side for the
		// entrance gate.
		const barrierSeg = 8;
		for ( const sign of [ 1, -1 ] ) {

			for ( let p = - roadHalf; p < roadHalf; p += barrierSeg ) {

				const segLen = Math.min( barrierSeg, roadHalf - p ) - 0.3; // small gaps between segments, like real jersey barrier sections
				if ( segLen <= 0 ) continue;
				const center = p + segLen / 2;

				// Leave the entrance gate gap on the north wall (+Z, sign=1, axis 'x')
				if ( sign === 1 && Math.abs( center ) < 3 ) continue;

				buildBarrierSegment( scene, null, center, sign * roadHalf, segLen, 'x' );
				buildBarrierSegment( scene, null, sign * roadHalf, center, segLen, 'z' );

			}

		}

		buildEntranceGate( scene, 0, roadHalf, 'x' );

		// Tire stacks in two corners, warning signs flanking the gate.
		buildTireStack( scene, roadHalf - 3, roadHalf - 3, 5 );
		buildTireStack( scene, - ( roadHalf - 3 ), - ( roadHalf - 3 ), 4 );
		buildTireStack( scene, roadHalf - 3, - ( roadHalf - 3 ), 6 );
		buildWarningSign( scene, -4.5, roadHalf - 1, Math.PI );
		buildWarningSign( scene, 4.5, roadHalf - 1, Math.PI );

		// All 4 vehicle models wander/drift here — unlike the race grid
		// (which reserves yellow for the player by default and uses the
		// other 3 for AI), free-roam has no such reservation.
		aiDrivers = createFreeRoamAI(
			[ { key: 'vehicle-truck-yellow' }, ...NPC_TRUCKS.map( ( [ key ] ) => ( { key } ) ) ],
			models, scene, world, roadHalf
		);
		freeRoamHalf = roadHalf;

		vehicleSpawn = { position: [ 0, 0.5, 0 ], angle: 0 };
		sphereBody = createSphereBody( world, vehicleSpawn.position );

	} else {

		// Compute track bounds and size physics/shadows to fit
		const bounds = computeTrackBounds( customCells );
		const hw = bounds.halfWidth;
		const hd = bounds.halfDepth;
		const groundSize = Math.max( hw, hd ) * 2 + 20;

		const shadowExtent = Math.max( hw, hd ) + 10;
		dirLight.shadow.camera.left = - shadowExtent;
		dirLight.shadow.camera.right = shadowExtent;
		dirLight.shadow.camera.top = shadowExtent;
		dirLight.shadow.camera.bottom = - shadowExtent;
		dirLight.shadow.camera.updateProjectionMatrix();

		scene.fog.near = groundSize * 0.4;
		scene.fog.far = groundSize * 0.8;

		const { npcConfigs } = buildTrack( scene, models, customCells );
		trackPath = computeTrackPath( customCells );

		// Probes
		const probeHeight = 6;
		const probes = new LightProbeGrid(
			hw * 2, probeHeight, hd * 2,
			Math.max( 4, Math.round( hw / 4 ) ),
			2,
			Math.max( 4, Math.round( hd / 4 ) ),
		);
		probes.position.set( bounds.centerX, probeHeight / 2, bounds.centerZ );
		probes.bake( renderer, scene, { cubemapSize: 32, near: 0.1, far: groundSize } );
		scene.add( probes );

		buildWallColliders( world, null, customCells );

		const roadHalf = groundSize / 2;
		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ bounds.centerX, - 0.125, bounds.centerZ ],
			friction: 5.0,
			restitution: 0.0,
		} );

		// Starting grid: player at the front, AI staggered behind —
		// instead of the player spawning exactly on the line.
		let gridSpawn = spawn;
		if ( spawn && npcConfigs.length > 0 ) {

			const gridSlots = computeGridPositions( spawn, 1 + npcConfigs.length );
			gridSpawn = gridSlots[ 0 ];
			aiDrivers = createAIDrivers( npcConfigs, gridSlots, models, scene, world, trackPath );

		}

		vehicleSpawn = gridSpawn;
		sphereBody = createSphereBody( world, gridSpawn ? gridSpawn.position : null );
		lapTimer = new LapTimer( customCells, mapParam );

	}

	const vehicle = new Vehicle();
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;

	if ( vehicleSpawn ) {

		const [ sx, sy, sz ] = vehicleSpawn.position;
		vehicle.spherePos.set( sx, sy, sz );
		vehicle.prevModelPos.set( sx, 0, sz );
		vehicle.container.rotation.y = vehicleSpawn.angle;

	}

	const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
	scene.add( vehicleGroup );
	addCustomTextDecals( vehicleGroup, customText );
	const vehicleLights = addVehicleLights( vehicleGroup );
	// flagImage comes from the main menu's image picker (a data: URL, see
	// createModeMenu) — falls back to the placeholder banner in Flag.js
	// if the player didn't pick one.
	const vehicleFlag = addVehicleFlag( vehicleGroup, flagImage );

	dirLight.target = vehicleGroup;

	const cam = new Camera();
	scene.add( cam.debug );

	const controls = new Controls();

	const particles = new SmokeTrails( scene );
	const driftMarks = new DriftMarks( scene, mapParam );

	const audio = new GameAudio();
	audio.init( cam.camera, vehicleGroup );

	const radio = new Radio( audio.listener, vehicleGroup );
	const touchState = setupRadioTouchUI( radio, vehicleLights );

	const _forward = new THREE.Vector3();
	const _camLead = new THREE.Vector3();

	const contactListener = {
		onContactAdded( bodyA, bodyB ) {

			if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;

			_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
			audio.playImpact( impactVelocity );

		}
	};

	const ctx = { world, vehicle, particles, driftMarks, audio, lapTimer, contactListener, vehicleFlag };

	// Radio controls for NORMAL mode (no VR controllers here, so keyboard
	// instead): R = next track, T = play/pause. L = headlights, H =
	// hazards. Edge-detected so holding a key doesn't rapid-fire.
	let prevKeys = { r: false, t: false, l: false, h: false };

	// Race start countdown — only for an actual track with a finish line
	// (not free-roam). Controls stay locked until it reaches zero.
	const isRace = !! ( lapTimer && lapTimer.enabled );
	const raceState = { phase: isRace ? 'countdown' : 'racing', countdown: 3, countdownTimer: 0, totalTime: 0 };
	let countdownUI = isRace ? createCountdownUI() : null;
	if ( countdownUI ) countdownUI.set( String( raceState.countdown ) );
	let resultsShown = false;

	if ( isRace ) {

		lapTimer.onFinish = () => { raceState.phase = 'finished'; };

	}

	return {

		frameUpdate( dt ) {

			if ( raceState.phase === 'countdown' ) {

				raceState.countdownTimer += dt;
				if ( raceState.countdownTimer >= 1 ) {

					raceState.countdownTimer -= 1;
					raceState.countdown -= 1;

					if ( raceState.countdown > 0 ) {

						countdownUI.set( String( raceState.countdown ) );

					} else {

						countdownUI.set( 'GO!' );
						raceState.phase = 'racing';
						setTimeout( () => { if ( countdownUI ) { countdownUI.remove(); countdownUI = null; } }, 500 );

					}

				}

			} else if ( raceState.phase === 'racing' ) {

				raceState.totalTime += dt;

			}

			const racing = raceState.phase === 'racing';
			const rawInput = controls.update();
			const input = racing ? rawInput : { x: 0, z: 0, touchActive: false };

			updateVehicleAndFx( dt, input, ctx );
			if ( isRace ) {

				updateAIDrivers( aiDrivers, trackPath, dt, racing, raceState.totalTime );

			} else {

				updateFreeRoamAI( aiDrivers, dt, freeRoamHalf );

			}
			updateVehicleLights( vehicleLights, dt, 1, vehicle.linearSpeed < -0.01 );

			if ( raceState.phase === 'finished' && ! resultsShown ) {

				resultsShown = true;
				const standings = computeStandings( aiDrivers, trackPath, raceState.totalTime );
				showRaceResultsOverlay( standings, {
					onRestart: () => location.reload(),
					onMenu: () => { location.href = location.pathname; },
				} );

			}

			const rKey = !! controls.keys[ 'KeyR' ];
			const tKey = !! controls.keys[ 'KeyT' ];
			const lKey = !! controls.keys[ 'KeyL' ];
			const hKey = !! controls.keys[ 'KeyH' ];
			const nKey = !! controls.keys[ 'KeyN' ];
			if ( rKey && ! prevKeys.r ) radio.next();
			if ( tKey && ! prevKeys.t ) radio.togglePlayPause();
			if ( lKey && ! prevKeys.l ) toggleHeadlights( vehicleLights );
			if ( hKey && ! prevKeys.h ) toggleHazards( vehicleLights );
			setHighBeam( vehicleLights, nKey || touchState.highBeamHeld );
			audio.setHorn( !! controls.keys[ 'Space' ] );
			prevKeys = { r: rKey, t: tKey, l: lKey, h: hKey };

			dirLight.position.set(
				vehicle.spherePos.x + 11.4,
				15,
				vehicle.spherePos.z - 5.3
			);

			const mv = vehicle.modelVelocity;
			_camLead.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).multiplyScalar( Math.sqrt( mv.x * mv.x + mv.z * mv.z ) );
			cam.update( dt, vehicle.spherePos, _camLead );

			renderer.render( scene, cam.camera );

		}

	};

}

// ─── AR MODE (Meta Quest 3 passthrough) ────────────────────

// Stage 2 test: a plain placeholder box you can grab, move, and resize
// in AR — proving out the shared mechanic (PlaceableObject.js) before
// it's used for the real floating track/arena. Deliberately skips
// ARManager's own hit-test floor-placement flow entirely (no session
// requiredFeature for it either) since this test doesn't need a floor,
// just controller tracking + passthrough, both of which ARManager's
// constructor/requestSession already set up.
async function startARPlaceableTest( { sessionPromise } ) {

	const arManager = new ARManager( { renderer, scene, models } );
	await arManager.requestSession( sessionPromise );
	arManager.previewGroup.visible = false; // not using hit-test placement here

	const placeholderCamera = new THREE.PerspectiveCamera();

	const box = new THREE.Mesh(
		new THREE.BoxGeometry( 0.3, 0.15, 0.4 ),
		new THREE.MeshStandardMaterial( { color: 0x5B8CFF, roughness: 0.4, metalness: 0.2 } )
	);
	// Roughly a meter in front of, and slightly below, wherever the
	// headset happens to be when the session starts — simplest possible
	// starting point for a grab-test; the real track placement will
	// need proper hit-test/preview like the existing room-drive AR mode.
	box.position.set( 0, 0.9, - 0.8 );
	scene.add( box );

	const light = new THREE.DirectionalLight( 0xffffff, 2 );
	light.position.set( 1, 2, 1 );
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.6 ) );

	const placeable = new PlaceableObject( box, arManager );
	placeable.onConfirm = () => {

		box.material.color.set( 0x5af168 ); // turns green once locked, so it's obvious the confirm worked

	};

	return {

		frameUpdate( dt ) {

			try {

				placeable.update( dt );

			} catch ( e ) {

				console.error( '[main] PlaceableObject test update() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

// ─── AR floating track (Stage 3) ────────────────────────────
// The default track, built exactly like NORMAL mode, but grabbable/
// movable/scalable (PlaceableObject, same mechanic proven in Stage 2)
// instead of fixed in place. No AI opponents yet — single car, kept
// simple for this first working version.
//
// Physics note: crashcat's rigid bodies live in absolute world space,
// completely disconnected from a THREE.Object3D's own transform — so a
// real physics car wouldn't follow the track being grabbed/moved/resized
// at all. Instead the car is a plain child of trackGroup with simple
// kinematic movement (position/heading updated directly, no rigid body),
// entirely in the group's local space — Three.js's normal parent-child
// transform inheritance then makes it automatically move/scale with the
// track for free, no extra bookkeeping needed. It trades away momentum/
// suspension/drift physics for correctness under a moving reference
// frame; can revisit if that trade turns out to matter in practice.
// ─── Kinematic AI (no physics — for the floating track/arena, ──
// ─── where crashcat's world-space rigid bodies can't follow    ──
// ─── a grabbable/scalable parent group's own transform)        ──
// Same path-following/lookahead-steering math as the web version's
// updateAIDrivers(), just operating on plain {x,z,heading,speed} state
// instead of a Vehicle+rigidBody, and parented under the track/arena
// group so movement is automatically correct after a grab or resize.

function createKinematicTrackAI( npcConfigs, gridSlots, models, parentGroup, path ) {

	if ( ! path || path.length < 2 ) return [];

	let totalLen = 0;
	for ( let j = 0; j < path.length; j ++ ) {

		const a = path[ j ], b = path[ ( j + 1 ) % path.length ];
		totalLen += Math.hypot( b.x - a.x, b.z - a.z );

	}
	const avgSpacing = totalLen / path.length;

	return npcConfigs.map( ( cfg, i ) => {

		const slot = gridSlots[ i + 1 ]; // slot 0 is the player
		const model = ( models[ cfg.key ] || models[ 'vehicle-truck-yellow' ] ).clone();
		model.traverse( ( c ) => { if ( c.isMesh ) { c.castShadow = false; c.receiveShadow = false; } } );
		model.position.set( slot.position[ 0 ], slot.position[ 1 ], slot.position[ 2 ] );
		model.rotation.y = slot.angle;
		parentGroup.add( model );

		const stepsBack = Math.round( slot.backDist / avgSpacing );
		const idx = ( ( path.length - stepsBack ) % path.length + path.length ) % path.length;

		return {
			model, idx,
			x: slot.position[ 0 ], z: slot.position[ 2 ], heading: slot.angle, speed: 0,
			y: slot.position[ 1 ],
		};

	} );

}

function updateKinematicTrackAI( drivers, path, dt, racing ) {

	if ( ! path || path.length < 2 ) return;

	const LOOKAHEAD = 2;
	const MAX_SPEED = 8, ACCEL = 10, TURN_RATE = 3;

	for ( const d of drivers ) {

		if ( ! racing ) continue;

		const target = path[ ( d.idx + 1 ) % path.length ];
		const dx0 = target.x - d.x, dz0 = target.z - d.z;
		if ( Math.hypot( dx0, dz0 ) < 1.0 ) d.idx = ( d.idx + 1 ) % path.length;

		const lookaheadPoint = path[ ( d.idx + LOOKAHEAD ) % path.length ];
		const dx = lookaheadPoint.x - d.x, dz = lookaheadPoint.z - d.z;
		const dist = Math.hypot( dx, dz );

		let targetSpeed = MAX_SPEED;
		if ( dist > 0.001 ) {

			const targetAngle = Math.atan2( dx, dz );
			let angleDiff = targetAngle - d.heading;
			angleDiff = ( ( angleDiff + Math.PI ) % ( Math.PI * 2 ) ) - Math.PI;

			d.heading += THREE.MathUtils.clamp( angleDiff, - TURN_RATE * dt, TURN_RATE * dt );

			const sharpness = THREE.MathUtils.clamp( Math.abs( angleDiff ) / ( Math.PI / 3 ), 0, 1 );
			targetSpeed = MAX_SPEED * ( 1 - sharpness * 0.5 );

		}

		d.speed += THREE.MathUtils.clamp( targetSpeed - d.speed, - ACCEL * dt, ACCEL * dt );
		d.x += Math.sin( d.heading ) * d.speed * dt;
		d.z += Math.cos( d.heading ) * d.speed * dt;

		d.model.position.set( d.x, d.y, d.z );
		d.model.rotation.y = d.heading;

	}

}

// Converts a LOCAL (pre-transform) {position:[x,y,z], angle} into WORLD
// space via the same yaw-only arTransform convention Physics.js uses,
// for spawning real physics bodies to match where the track visually
// ended up after being grabbed/moved/scaled.
function arTransformSpawn( position, angle, arTransform ) {

	const localQuat = [ 0, Math.sin( angle / 2 ), 0, Math.cos( angle / 2 ) ];
	const { position: wp, quaternion: wq } = applyArTransform( position, localQuat, arTransform );
	const yaw = new THREE.Euler().setFromQuaternion( new THREE.Quaternion( wq[ 0 ], wq[ 1 ], wq[ 2 ], wq[ 3 ] ), 'YXZ' ).y;
	return { position: wp, angle: yaw };

}

async function startARFloatingTrack( { vehicleKey, customText, flagImage, sessionPromise } ) {

	// STAGE 1 (placement) + STAGE 2 (rebuild): place + lock the track,
	// then spawn a full-featured real-physics car on it — same feature
	// set as room-drive AR mode (lights, flag, text, smoke, drift marks,
	// audio, radio, horn), just at the track's fixed AR scale instead of
	// a user-resizable one.
	const arManager = new ARManager( { renderer, scene, models } );
	await arManager.requestSession( sessionPromise );
	arManager.previewGroup.visible = false; // not using hit-test placement here

	const placeholderCamera = new THREE.PerspectiveCamera();

	const { trackGroup } = buildTrack( scene, models, null, { skipDeco: true } );
	const spawn = computeSpawnPosition( null );
	const bounds = computeTrackBounds( TRACK_CELLS );

	const FIXED_SCALE = 0.016;
	trackGroup.scale.setScalar( FIXED_SCALE );
	// Closer (was 1.3m, halved to 0.65m) and lower (below eye level,
	// tabletop-style). Rotated 180° from the finish line's own forward
	// angle so the start gate faces back toward the viewer instead of
	// away — best guess pending visual confirmation.
	trackGroup.position.set( 0, 0.55, - 0.85 );
	trackGroup.rotation.y = spawn.angle; // rotated 180° again from the previous +PI, back to the original

	const light = new THREE.DirectionalLight( 0xffffff, 3 );
	light.position.set( 0.6, 1, 0.6 );
	light.castShadow = true;
	// Shadow camera frustum sized to the track's small AR footprint
	// (span ≈ 60 × FIXED_SCALE meters) — the default frustum is tuned
	// for NORMAL mode's much larger real-scale track and was far too
	// wide here, making shadow resolution effectively zero.
	const shadowExtent = 60 * FIXED_SCALE;
	light.shadow.camera.left = - shadowExtent;
	light.shadow.camera.right = shadowExtent;
	light.shadow.camera.top = shadowExtent;
	light.shadow.camera.bottom = - shadowExtent;
	light.shadow.camera.near = 0.1;
	light.shadow.camera.far = shadowExtent * 4;
	light.shadow.mapSize.setScalar( 1024 );
	light.shadow.camera.updateProjectionMatrix();
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.6 ) );

	// Grab hitbox is the start gate specifically (a small range right at
	// the finish line's position), not the whole track — grabbing from
	// anywhere near the track made accidental grabs too easy.
	const gatePoint = new THREE.Vector3( spawn.position[ 0 ], 0, spawn.position[ 2 ] );
	const placeable = new PlaceableObject( trackGroup, arManager, {
		minScale: FIXED_SCALE, maxScale: FIXED_SCALE, // locked — resize comes back in a later stage
		grabPoint: gatePoint, grabRange: 0.15,
	} );

	let raceCtx = null;

	placeable.onConfirm = () => {

		// The grab-highlight glow was staying on forever after lock —
		// explicitly clear it back to normal now that it's done being
		// held.
		placeable._setHighlight( 'none' );

		// Track stays exactly where/how big it is from this point on —
		// real physics colliders are built to match THIS transform once
		// (crashcat's rigid bodies live in absolute world space, not
		// trackGroup's own transform, so they'd desync from any further
		// grab — which is why resize/move are locked at this stage).
		const yaw = new THREE.Euler().setFromQuaternion( trackGroup.quaternion, 'YXZ' ).y;
		const yawQuat = new THREE.Quaternion().setFromEuler( new THREE.Euler( 0, yaw, 0 ) );
		const arTransform = { position: trackGroup.position.clone(), quaternion: yawQuat, scale: trackGroup.scale.x };

		// Gravity scaled down with the track — real 9.81 m/s² acting on
		// a sphere shrunk to AR-tabletop size is a huge force relative
		// to its own tiny size, causing violent jitter/bouncing instead
		// of the car settling naturally onto the track.
		const world = createPhysicsWorld( arTransform.scale );
		buildWallColliders( world, null, null, arTransform );

		const groundHalfY = Math.max( 0.01 * arTransform.scale, 0.02 );
		const groundXf = applyArTransform( [ bounds.centerX, - 0.125, bounds.centerZ ], [ 0, 0, 0, 1 ], arTransform );
		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ bounds.halfWidth * arTransform.scale, groundHalfY, bounds.halfDepth * arTransform.scale ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: groundXf.position,
			friction: 5.0,
			restitution: 0.0,
		} );

		// Physics sphere scaled to match the track instead of the
		// hardcoded real-0.5m default — otherwise it's comically
		// oversized relative to a tabletop-sized loop.
		const carRadius = Math.max( 0.5 * arTransform.scale, 0.003 );

		const playerWorld = arTransformSpawn( spawn.position, spawn.angle, arTransform );
		const sphereBody = createSphereBody( world, playerWorld.position, carRadius );

		const vehicle = new Vehicle();
		vehicle.sphereRadius = carRadius;
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spherePos.set( playerWorld.position[ 0 ], playerWorld.position[ 1 ], playerWorld.position[ 2 ] );
		vehicle.prevModelPos.set( playerWorld.position[ 0 ], 0, playerWorld.position[ 2 ] );
		vehicle.container.rotation.y = playerWorld.angle;

		const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
		vehicleGroup.scale.setScalar( arTransform.scale ); // matches the track's own fixed scale — Vehicle.js never touches .scale itself, so this persists safely
		scene.add( vehicleGroup );
		addCustomTextDecals( vehicleGroup, customText );
		const vehicleLights = addVehicleLights( vehicleGroup );
		const vehicleFlag = addVehicleFlag( vehicleGroup, flagImage );

		const audio = new GameAudio();
		audio.init( renderer.xr.getCamera(), vehicleGroup );
		audio.forceUnlock();
		const radio = new Radio( audio.listener, vehicleGroup );

		// NORMAL mode uses SmokeTrails at scale=1 for a full-size car —
		// this car is `arTransform.scale` of that size, so smoke uses
		// the same proportion directly.
		const particles = new SmokeTrails( scene, arTransform.scale );
		const driftMarks = new DriftMarks( scene, 'ar-floating-track' );

		const _forward = new THREE.Vector3();
		const contactListener = {
			onContactAdded( bodyA, bodyB ) {

				if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;
				_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
				_forward.y = 0;
				_forward.normalize();
				const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
				audio.playImpact( impactVelocity );

			}
		};

		const ctx = { world, vehicle, particles, driftMarks, audio, lapTimer: null, contactListener, vehicleFlag };

		raceCtx = { world, vehicle, vehicleGroup, vehicleLights, audio, radio, ctx, arScale: arTransform.scale };

	};

	return {

		frameUpdate( dt ) {

			try {

				if ( ! placeable.confirmed ) {

					placeable.update( dt );

				} else if ( raceCtx ) {

					const input = arManager.getDriveInput();
					updateVehicleAndFx( dt, input, raceCtx.ctx );
					updateVehicleLights( raceCtx.vehicleLights, dt, raceCtx.arScale, raceCtx.vehicle.linearSpeed < -0.01 );

					if ( arManager.getHeadlightToggle() ) toggleHeadlights( raceCtx.vehicleLights );
					if ( arManager.getHazardToggle() ) toggleHazards( raceCtx.vehicleLights );
					setHighBeam( raceCtx.vehicleLights, arManager.getHighBeamHold(), raceCtx.arScale );
					raceCtx.audio.setHorn( arManager.getHornHold() );

					const radioBtn = arManager.getRadioButtons();
					if ( radioBtn.next ) raceCtx.radio.next();
					if ( radioBtn.toggle ) raceCtx.radio.togglePlayPause();

				}

			} catch ( e ) {

				console.error( '[main] floating-track frameUpdate() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

// ─── AR floating arena (Stage 4) ────────────────────────────
// A plain open square for drifting — flat asphalt with the track's own
// red/white barrier around all 4 edges (buildBarrierSegment, same as the
// real track, world=null for visual-only/no physics) and nothing else
// inside: no walls, no decoration, no track loop. Grabbable/movable/
// scalable (PlaceableObject) and a simple kinematic car, same mechanic
// as the floating track.
function buildDriftPad( half, models ) {

	const pad = new THREE.Group();

	// Real asset (models/ground-tile.glb) instead of a runtime
	// PlaneGeometry — same color, now an actual game asset like every
	// other piece in the project. The source tile is 10×0.1×10, so it's
	// scaled non-uniformly to cover the full pad footprint.
	const groundSrc = models[ 'ground-tile' ];
	if ( groundSrc ) {

		const groundMesh = groundSrc.clone();
		groundMesh.scale.set( ( half * 2 ) / 10, 1, ( half * 2 ) / 10 );
		groundMesh.position.y = - 0.05; // top face flush with y=0, matching the tile's own 0.1 thickness
		pad.add( groundMesh );

	}

	// Real asset (models/barrier-segment.glb, 8 units long) instead of
	// runtime-built boxes — each instance is a small wrapper group so
	// the segment can be length-scaled in its own local space before
	// the group applies the 90°-per-axis rotation, since scale and
	// rotation don't commute otherwise.
	const barrierSrc = models[ 'barrier-segment' ];
	const barrierSeg = 8;

	function placeBarrier( center, fixedCoord, segLen, axis ) {

		if ( ! barrierSrc ) return;

		const instance = barrierSrc.clone();
		instance.scale.x = segLen / barrierSeg;

		const wrapper = new THREE.Group();
		wrapper.add( instance );

		if ( axis === 'x' ) {

			wrapper.position.set( center, 0, fixedCoord );

		} else {

			wrapper.rotation.y = Math.PI / 2;
			wrapper.position.set( fixedCoord, 0, center );

		}

		pad.add( wrapper );

	}

	for ( const sign of [ 1, -1 ] ) {

		for ( let p = - half; p < half; p += barrierSeg ) {

			const segLen = Math.min( barrierSeg, half - p ) - 0.3; // small gaps between segments, like real jersey barrier sections
			if ( segLen <= 0 ) continue;
			const center = p + segLen / 2;

			placeBarrier( center, sign * half, segLen, 'x' );
			placeBarrier( center, sign * half, segLen, 'z' );

		}

	}

	return pad;

}

// Kinematic version of the web free-roam AI (random wander target,
// always full throttle, no easing off for turns — same idea as
// updateFreeRoamAI in the web build) for the floating arena.
function createKinematicArenaAI( npcConfigs, models, parentGroup, padHalf ) {

	const spawnMargin = padHalf * 0.5;

	return npcConfigs.map( ( cfg, i ) => {

		const angle = ( i / npcConfigs.length ) * Math.PI * 2;
		const dist = spawnMargin * ( 0.4 + Math.random() * 0.5 );
		const x = Math.cos( angle ) * dist;
		const z = Math.sin( angle ) * dist;
		const heading = Math.random() * Math.PI * 2;

		const model = ( models[ cfg.key ] || models[ 'vehicle-truck-yellow' ] ).clone();
		model.traverse( ( c ) => { if ( c.isMesh ) { c.castShadow = false; c.receiveShadow = false; } } );
		model.position.set( x, 0.5, z );
		model.rotation.y = heading;
		parentGroup.add( model );

		return { model, x, z, heading, speed: 0, target: { x, z }, retargetTimer: 0 };

	} );

}

function updateKinematicArenaAI( drivers, dt, racing, padHalf ) {

	const wanderRadius = padHalf * 0.6;
	const MAX_SPEED = 8, ACCEL = 10, TURN_RATE = 3.5;

	for ( const d of drivers ) {

		if ( ! racing ) continue;

		d.retargetTimer -= dt;
		const distToTarget = Math.hypot( d.target.x - d.x, d.target.z - d.z );

		if ( d.retargetTimer <= 0 || distToTarget < 3 ) {

			const a = Math.random() * Math.PI * 2;
			const r = Math.random() * wanderRadius;
			d.target = { x: Math.cos( a ) * r, z: Math.sin( a ) * r };
			d.retargetTimer = 2 + Math.random() * 3;

		}

		const dx = d.target.x - d.x, dz = d.target.z - d.z;
		const dist = Math.hypot( dx, dz );

		if ( dist > 0.001 ) {

			const targetAngle = Math.atan2( dx, dz );
			let angleDiff = targetAngle - d.heading;
			angleDiff = ( ( angleDiff + Math.PI ) % ( Math.PI * 2 ) ) - Math.PI;
			d.heading += THREE.MathUtils.clamp( angleDiff, - TURN_RATE * dt, TURN_RATE * dt );

		}

		d.speed += THREE.MathUtils.clamp( MAX_SPEED - d.speed, - ACCEL * dt, ACCEL * dt );
		d.x += Math.sin( d.heading ) * d.speed * dt;
		d.z += Math.cos( d.heading ) * d.speed * dt;

		const margin = 2;
		d.x = THREE.MathUtils.clamp( d.x, - padHalf + margin, padHalf - margin );
		d.z = THREE.MathUtils.clamp( d.z, - padHalf + margin, padHalf - margin );

		d.model.position.set( d.x, 0.5, d.z );
		d.model.rotation.y = d.heading;

	}

}

async function startARFloatingArena( { vehicleKey, sessionPromise } ) {

	const arManager = new ARManager( { renderer, scene, models } );
	await arManager.requestSession( sessionPromise );
	arManager.previewGroup.visible = false; // not using hit-test placement here

	const placeholderCamera = new THREE.PerspectiveCamera();

	const PAD_HALF = 30; // half-size, in the pad's own (unscaled) coordinate space
	const arenaGroup = buildDriftPad( PAD_HALF, models );

	// Small tabletop scale by default, positioned a short reach in front
	// of wherever the headset happens to be when the session starts —
	// same reasoning as the floating track.
	arenaGroup.scale.setScalar( 0.04 );
	arenaGroup.position.set( 0, 0.9, - 0.6 );
	scene.add( arenaGroup );

	const light = new THREE.DirectionalLight( 0xffffff, 2.5 );
	light.position.set( 1, 2, 1 );
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.7 ) );

	const placeable = new PlaceableObject( arenaGroup, arManager, { minScale: 0.005, maxScale: 0.1 } );

	const carContainer = new THREE.Group();
	const carModel = ( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] ).clone();
	carModel.traverse( ( c ) => { if ( c.isMesh ) { c.castShadow = false; c.receiveShadow = false; } } );
	carContainer.add( carModel );
	carContainer.position.set( 0, 0.5, 0 );
	arenaGroup.add( carContainer ); // child of arenaGroup — inherits its transform automatically

	const vehicleLights = addVehicleLights( carContainer );

	const audio = new GameAudio();
	audio.init( renderer.xr.getCamera(), carContainer );
	audio.forceUnlock();

	const radio = new Radio( audio.listener, carContainer );

	const car = { x: 0, z: 0, heading: 0, speed: 0 };
	const CAR_MAX_SPEED = 8; // local units/sec, in the arena's own (unscaled) coordinate space
	const CAR_ACCEL = 10;
	const CAR_TURN_RATE = 2.4; // rad/sec at full speed

	const aiDrivers = createKinematicArenaAI(
		NPC_TRUCKS.map( ( [ key ] ) => ( { key } ) ),
		models, arenaGroup, PAD_HALF
	);

	let racing = false;

	placeable.onConfirm = () => {

		racing = true;

	};

	return {

		frameUpdate( dt ) {

			try {

				placeable.update( dt );
				updateKinematicArenaAI( aiDrivers, dt, racing, PAD_HALF );

				if ( racing ) {

					const gp = arManager.gamepads.right;
					const axes = gp ? gp.axes : [];
					const steerRaw = axes.length > 2 ? axes[ 2 ] : 0;
					const steer = Math.abs( steerRaw ) > 0.12 ? steerRaw : 0;
					const throttle = gp && gp.buttons[ 0 ] ? gp.buttons[ 0 ].value : 0;
					const brake = arManager.gamepads.left && arManager.gamepads.left.buttons[ 0 ]
						? arManager.gamepads.left.buttons[ 0 ].value : 0;

					const targetSpeed = ( throttle - brake ) * CAR_MAX_SPEED;
					car.speed += THREE.MathUtils.clamp( targetSpeed - car.speed, - CAR_ACCEL * dt, CAR_ACCEL * dt );

					const turnFactor = THREE.MathUtils.clamp( Math.abs( car.speed ) / CAR_MAX_SPEED, 0.15, 1 );
					car.heading -= steer * CAR_TURN_RATE * turnFactor * dt * Math.sign( car.speed || 1 );

					car.x += Math.sin( car.heading ) * car.speed * dt;
					car.z += Math.cos( car.heading ) * car.speed * dt;

					// Crude boundary clamp (simple square pad) — not real
					// wall collision, just keeps the car inside. No real
					// rigid body here for a genuine contact event, so an
					// impact sound plays whenever the clamp actually
					// catches meaningful speed — a stand-in for "hit the
					// barrier".
					const margin = 2;
					const clampedX = THREE.MathUtils.clamp( car.x, - PAD_HALF + margin, PAD_HALF - margin );
					const clampedZ = THREE.MathUtils.clamp( car.z, - PAD_HALF + margin, PAD_HALF - margin );
					if ( ( clampedX !== car.x || clampedZ !== car.z ) && Math.abs( car.speed ) > 1.5 ) {

						audio.playImpact( Math.abs( car.speed ) );
						car.speed *= 0.3;

					}
					car.x = clampedX;
					car.z = clampedZ;

					carContainer.position.set( car.x, 0.5, car.z );
					carContainer.rotation.y = car.heading;

					// Rough drift-intensity stand-in: sharper steering at
					// higher speed reads as more sideways slide, matching
					// this mode's always-full-throttle drift-show feel.
					const driftEstimate = THREE.MathUtils.clamp( Math.abs( steer ) * ( Math.abs( car.speed ) / CAR_MAX_SPEED ), 0, 1 );
					audio.update( dt, car.speed / CAR_MAX_SPEED, throttle - brake, driftEstimate, car.speed < -0.01 );

				}

				updateVehicleLights( vehicleLights, dt, arenaGroup.scale.x, car.speed < -0.01 );
				if ( arManager.getHeadlightToggle() ) toggleHeadlights( vehicleLights );
				if ( arManager.getHazardToggle() ) toggleHazards( vehicleLights );
				setHighBeam( vehicleLights, arManager.getHighBeamHold() );
				audio.setHorn( arManager.getHornHold() );

				const radioBtn = arManager.getRadioButtons();
				if ( radioBtn.next ) radio.next();
				if ( radioBtn.toggle ) radio.togglePlayPause();

			} catch ( e ) {

				console.error( '[main] floating-arena frameUpdate() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

async function startARMode( { mapParam, customText, vehicleKey, flagImage, sessionPromise } ) {

	const arManager = new ARManager( { renderer, scene, models } );
	const world = createPhysicsWorld();
	arManager.setWorld( world );

	const placeholderCamera = new THREE.PerspectiveCamera(); // pose is overridden by WebXR while presenting

	let gameState = null; // populated once the user confirms spawn placement
	const controls = new Controls();

	arManager.onPlaced = ( spawn ) => {

		const sphereBody = createSphereBody( world, [ spawn.position.x, spawn.position.y, spawn.position.z ] );

		const vehicle = new Vehicle();
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spherePos.copy( spawn.position );
		vehicle.prevModelPos.set( spawn.position.x, 0, spawn.position.z );
		vehicle.container.rotation.y = spawn.angle;

		// The vehicle stays a direct child of `scene` (true WebXR world
		// space), matching how physics already works in NORMAL mode.
		const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
		scene.add( vehicleGroup );
		addCustomTextDecals( vehicleGroup, customText );
		const vehicleLights = addVehicleLights( vehicleGroup );
		const vehicleFlag = addVehicleFlag( vehicleGroup, flagImage );

		dirLight.target = vehicleGroup;

		// vehicleGroup's own origin isn't necessarily at wheel/ground level,
		// so scaling it directly made the car sink into or float above the
		// real floor as it resized. Instead scale only the inner model
		// child, and keep its lowest point pinned at the container's origin
		// (ground level) regardless of scale.
		const vehicleModel = vehicleGroup.children[ 0 ];
		const vehicleModelMinY = new THREE.Box3().setFromObject( vehicleModel ).min.y;

		// Smoke is authored at real-meter scale (BASE_SIZE=1 in Particles.js)
		// for NORMAL mode's much larger track. In AR the car is toy-sized,
		// so shrink smoke drastically or it renders as room-filling clouds
		// — a likely cause of the GPU overdraw/lag reported during drifting.
		const particles = new SmokeTrails( scene, 0.12 );
		const driftMarks = new DriftMarks( scene, mapParam || 'ar-freeroam' );

		const audio = new GameAudio();
		audio.init( renderer.xr.getCamera(), vehicleGroup ); // XR camera rig instead of the NORMAL-mode chase Camera
		// AR mode has no DOM click/touchstart/keydown once inside the XR
		// session (input is XR controller triggers only), so Audio.js's
		// normal gesture-based unlock() would never fire and every sound
		// would stay silent forever. We already know a real user gesture
		// happened (the "Start AR" button press that got us into this
		// session), so it's safe to unlock immediately here instead.
		audio.forceUnlock();

		const radio = new Radio( audio.listener, vehicleGroup );

		const _forward = new THREE.Vector3();

		const contactListener = {
			onContactAdded( bodyA, bodyB ) {

				if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;

				_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
				_forward.y = 0;
				_forward.normalize();

				const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
				audio.playImpact( impactVelocity );

			}
		};

		// No lapTimer — free-roam has no track/laps.
		gameState = {
			vehicle, vehicleGroup, vehicleModel, vehicleModelMinY, vehicleScale: 1,
			particles, driftMarks, audio, radio, vehicleLights, vehicleFlag, contactListener
		};

	};

	const xrSession = await arManager.requestSession( sessionPromise );

	// Custom post-processing (bloom) is authored for a single flat camera
	// and is not guaranteed to handle WebXR's per-eye ArrayCamera stereo
	// rendering correctly — a mismatch here is a known cause of content
	// appearing to lag/swim with head movement. Disable while presenting.
	renderer.setEffects( [] );
	xrSession.addEventListener( 'end', () => {

		renderer.setEffects( [ bloomPass ] );

	} );

	return {

		frameUpdate( dt, timestamp, frame ) {

			try {

				arManager.update( frame, dt );

				if ( gameState ) {

					// Controllers drive the car once the track is locked in;
					// keyboard/gamepad still work too (e.g. testing on desktop).
					const kbInput = controls.update();
					const arInput = arManager.getDriveInput();
					const input = {
						x: Math.abs( arInput.x ) > Math.abs( kbInput.x ) ? arInput.x : kbInput.x,
						z: Math.abs( arInput.z ) > Math.abs( kbInput.z ) ? arInput.z : kbInput.z,
						touchActive: kbInput.touchActive,
						handbrake: kbInput.handbrake || arManager.getHandbrakeHold(),
					};

					updateVehicleAndFx( dt, input, { world, ...gameState } );
					updateVehicleLights( gameState.vehicleLights, dt, gameState.vehicleScale, gameState.vehicle.linearSpeed < -0.01 );

					const scaleInput = arManager.getScaleAdjustInput();
					if ( scaleInput !== 0 ) {

						gameState.vehicleScale = THREE.MathUtils.clamp(
							gameState.vehicleScale * ( 1 - scaleInput * 0.8 * dt ),
							0.03, 3.0
						);

						const s = gameState.vehicleScale;
						gameState.vehicleModel.scale.setScalar( s );
						// Keep the model's lowest point (wheels) pinned at
						// y=0 in container space — i.e. at ground level —
						// instead of scaling around the model's own origin,
						// which caused it to sink into or float above the
						// real floor as it resized.
						gameState.vehicleModel.position.y = gameState.vehicleModelMinY * ( 1 - s );

					}

					const radioBtn = arManager.getRadioButtons();
					if ( radioBtn.next ) gameState.radio.next();
					if ( radioBtn.toggle ) gameState.radio.togglePlayPause();

					if ( arManager.getHeadlightToggle() ) toggleHeadlights( gameState.vehicleLights );
					if ( arManager.getHazardToggle() ) toggleHazards( gameState.vehicleLights );
					setHighBeam( gameState.vehicleLights, arManager.getHighBeamHold(), gameState.vehicleScale );
					gameState.audio.setHorn( arManager.getHornHold() );

					if ( gameState.vehicleLights ) {

						arManager.setFloorGridVisible( gameState.vehicleLights.headlights[ 0 ].light.visible );

					}

					dirLight.position.set(
						gameState.vehicle.spherePos.x + 11.4,
						15,
						gameState.vehicle.spherePos.z - 5.3
					);

				} else {

					// Placement phase: still step physics so nothing is stale
					// once the vehicle spawns, but there is no vehicle yet.
					updateWorld( world, null, dt );

				}

			} catch ( e ) {

				console.error( '[main] AR frameUpdate() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

// ─── Shared animate loop ───────────────────────────────────

let activeMode = null;
const timer = new THREE.Timer();
let crashed = false;

function animate( timestamp, frame ) {

	if ( crashed ) return;

	timer.update( timestamp );
	const dt = Math.min( timer.getDelta(), 1 / 30 );

	try {

		if ( activeMode ) activeMode.frameUpdate( dt, timestamp, frame );

	} catch ( e ) {

		crashed = true;
		console.error( '[animate] crashed:', e );
		showGenericErrorOverlay( e );

	}

}

renderer.setAnimationLoop( animate );

function showGenericErrorOverlay( error ) {

	const box = document.createElement( 'div' );
	box.dir = 'rtl';
	box.style.cssText = `
		position: fixed; inset: 0; z-index: 70; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center;
		background: rgba(20,22,26,0.95); font-family: 'Segoe UI', Tahoma, Arial, sans-serif; overflow-y: auto;
	`;

	const title = document.createElement( 'div' );
	title.textContent = 'صار خطأ وتوقفت اللعبة';
	title.style.cssText = 'color:#fff; font-size:20px; font-weight:700;';

	const msg = document.createElement( 'div' );
	msg.textContent = String( error && error.message ? error.message : error );
	msg.style.cssText = 'color:#ffb4b4; font-size:14px; max-width:90%;';

	const stack = document.createElement( 'pre' );
	stack.textContent = error && error.stack ? error.stack : '';
	stack.style.cssText = `
		color:#9a94b0; font-size:11px; text-align:left; direction:ltr; max-width:90%; max-height:40vh;
		overflow:auto; background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; white-space:pre-wrap;
	`;

	box.appendChild( title );
	box.appendChild( msg );
	box.appendChild( stack );
	document.body.appendChild( box );

}

function showErrorOverlay( message, stack, onRetry, title = 'تعذّر تشغيل وضع الواقع المعزز' ) {

	const box = document.createElement( 'div' );
	box.dir = 'rtl';
	box.style.cssText = `
		position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 16px; padding: 24px; text-align: center;
		background: rgba(20,22,26,0.92); font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
	`;

	const titleEl = document.createElement( 'div' );
	titleEl.textContent = title;
	titleEl.style.cssText = 'color:#fff; font-size:18px; font-weight:600;';

	const detail = document.createElement( 'div' );
	detail.textContent = message;
	detail.dir = 'ltr'; // raw browser/JS error text — keep readable, not mirrored
	detail.style.cssText = 'color:#ddd; font-size:14px; max-width:640px; white-space:pre-wrap;';

	const stackBox = document.createElement( 'div' );
	stackBox.textContent = stack ? stack.split( '\n' ).slice( 0, 6 ).join( '\n' ) : '';
	stackBox.dir = 'ltr';
	stackBox.style.cssText = 'color:#999; font-size:11px; max-width:640px; white-space:pre-wrap; text-align:left; font-family:monospace;';

	const retryBtn = document.createElement( 'button' );
	retryBtn.textContent = 'العودة للقائمة';
	retryBtn.style.cssText = `
		padding: 12px 28px; font-size: 15px; border-radius: 999px; border: none;
		cursor: pointer; background: #15A249; color: #fff;
	`;
	retryBtn.addEventListener( 'click', () => {

		box.remove();
		onRetry();

	} );

	box.appendChild( titleEl );
	box.appendChild( detail );
	box.appendChild( stackBox );
	box.appendChild( retryBtn );
	document.body.appendChild( box );

	console.error( title + ':', message, stack );

}

async function init() {

	registerAll();
	await loadModels();

	const mapParam = new URLSearchParams( window.location.search ).get( 'map' );
	let customCells = null;
	// Was only computed inside the `if (mapParam)` block below, leaving
	// it null for the default track (no ?map=) — which silently skipped
	// the grid-start/AI-opponent system, since that code all guards on
	// `spawn` being present. computeSpawnPosition() now defaults to the
	// built-in TRACK_CELLS on its own, so this works for both cases.
	let spawn = computeSpawnPosition( null );

	if ( mapParam ) {

		try {

			customCells = decodeCells( mapParam );
			spawn = computeSpawnPosition( customCells );

		} catch ( e ) {

			console.warn( 'Invalid map parameter, using default track' );

		}

	}

	const arAvailable = await ARManager.isSupported();

	// eslint-disable-next-line no-constant-condition
	while ( true ) {

		const { choice, arSubMode, customText, freeRoam, vehicleKey, flagImage, sessionPromise } = await createModeMenu( { arAvailable } );

		if ( choice === 'ar' && arSubMode === 'track' ) {

			try {

				activeMode = await startARFloatingTrack( { vehicleKey, customText, flagImage, sessionPromise } );
				break;

			} catch ( e ) {

				activeMode = null;

				await new Promise( ( resolve ) => {

					showErrorOverlay(
						( e && e.message ) ? e.message : String( e ),
						e && e.stack ? e.stack : '',
						resolve,
						'تعذّر تشغيل المضمار العائم'
					);

				} );
				continue;

			}

		} else if ( choice === 'ar' && arSubMode === 'arena' ) {

			try {

				activeMode = await startARFloatingArena( { vehicleKey, sessionPromise } );
				break;

			} catch ( e ) {

				activeMode = null;

				await new Promise( ( resolve ) => {

					showErrorOverlay(
						( e && e.message ) ? e.message : String( e ),
						e && e.stack ? e.stack : '',
						resolve,
						'تعذّر تشغيل الحلبة العائمة'
					);

				} );
				continue;

			}

		} else if ( choice === 'ar' ) {

			try {

				activeMode = await startARMode( { mapParam, customText, vehicleKey, flagImage, sessionPromise } );
				break;

			} catch ( e ) {

				activeMode = null;

				await new Promise( ( resolve ) => {

					showErrorOverlay(
						( e && e.message ) ? e.message : String( e ),
						e && e.stack ? e.stack : '',
						resolve
					);

				} );
				continue; // back to the mode menu instead of a silent black screen

			}

		} else {

			try {

				activeMode = startNormalMode( { customCells, spawn, mapParam, customText, freeRoam, vehicleKey, flagImage } );
				break;

			} catch ( e ) {

				activeMode = null;

				await new Promise( ( resolve ) => {

					showErrorOverlay(
						( e && e.message ) ? e.message : String( e ),
						e && e.stack ? e.stack : '',
						resolve
					);

				} );
				continue; // back to the mode menu instead of a silent black screen

			}

		}

	}

}

init();

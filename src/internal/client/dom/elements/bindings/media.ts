import { render_effect, effect, teardown } from '../../../reactivity/effects.ts';
import { listen } from './shared.ts';

type Media = HTMLVideoElement | HTMLAudioElement;
type Range = { start: number; end: number };

function time_ranges_to_array(ranges: TimeRanges): Range[] {
	var array = [];

	for (var i = 0; i < ranges.length; i += 1) {
		array.push({ start: ranges.start(i), end: ranges.end(i) });
	}

	return array;
}

export function bind_current_time(
	media: Media,
	get: () => number | undefined,
	set: (value: number) => void = get
): void {
	var raf_id: number;
	var value: number;

	// Ideally, listening to timeupdate would be enough, but it fires too infrequently for the currentTime
	// binding, which is why we use a raf loop, too. We additionally still listen to timeupdate because
	// the user could be scrubbing through the video using the native controls when the media is paused.
	var callback = () => {
		cancelAnimationFrame(raf_id);

		if (!media.paused) {
			raf_id = requestAnimationFrame(callback);
		}

		var next_value = media.currentTime;
		if (value !== next_value) {
			set((value = next_value));
		}
	};

	raf_id = requestAnimationFrame(callback);
	media.addEventListener('timeupdate', callback);

	render_effect(() => {
		var next_value = Number(get());

		if (value !== next_value && !isNaN(next_value)) {
			media.currentTime = value = next_value;
		}
	});

	teardown(() => {
		cancelAnimationFrame(raf_id);
		media.removeEventListener('timeupdate', callback);
	});
}

export function bind_buffered(media: Media, set: (array: Range[]) => void): void {
	var current: Range[];

	// `buffered` can update without emitting any event, so we check it on various events.
	// By specs, `buffered` always returns a new object, so we have to compare deeply.
	listen(media, ['loadedmetadata', 'progress', 'timeupdate', 'seeking'], () => {
		var ranges = media.buffered;

		if (
			!current ||
			current.length !== ranges.length ||
			current.some((range, i) => ranges.start(i) !== range.start || ranges.end(i) !== range.end)
		) {
			current = time_ranges_to_array(ranges);
			set(current);
		}
	});
}

export function bind_seekable(media: Media, set: (array: Range[]) => void): void {
	listen(media, ['loadedmetadata'], () => set(time_ranges_to_array(media.seekable)));
}

export function bind_played(media: Media, set: (array: Range[]) => void): void {
	listen(media, ['timeupdate'], () => set(time_ranges_to_array(media.played)));
}

export function bind_seeking(media: Media, set: (seeking: boolean) => void): void {
	listen(media, ['seeking', 'seeked'], () => set(media.seeking));
}

export function bind_ended(media: Media, set: (ended: boolean) => void): void {
	listen(media, ['timeupdate', 'ended'], () => set(media.ended));
}

export function bind_ready_state(media: Media, set: (ready_state: number) => void): void {
	listen(
		media,
		['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'waiting', 'emptied'],
		() => set(media.readyState)
	);
}

export function bind_playback_rate(
	media: Media,
	get: () => number | undefined,
	set: (playback_rate: number) => void = get
): void {
	// Needs to happen after element is inserted into the dom (which is guaranteed by using effect),
	// else playback will be set back to 1 by the browser
	effect(() => {
		var value = Number(get());

		if (value !== media.playbackRate && !isNaN(value)) {
			media.playbackRate = value;
		}
	});

	// Start listening to ratechange events after the element is inserted into the dom,
	// else playback will be set to 1 by the browser
	effect(() => {
		listen(media, ['ratechange'], () => {
			set(media.playbackRate);
		});
	});
}

export function bind_paused(
	media: Media,
	get: () => boolean | undefined,
	set: (paused: boolean) => void = get
): void {
	var paused = get();

	var update = () => {
		if (paused !== media.paused) {
			set((paused = media.paused));
		}
	};

	// If someone switches the src while media is playing, the player will pause.
	// Listen to the canplay event to get notified of this situation.
	listen(media, ['play', 'pause', 'canplay'], update, paused == null);

	// Needs to be an effect to ensure media element is mounted: else, if paused is `false` (i.e. should play right away)
	// a "The play() request was interrupted by a new load request" error would be thrown because the resource isn't loaded yet.
	effect(() => {
		if ((paused = !!get()) !== media.paused) {
			if (paused) {
				media.pause();
			} else {
				media.play().catch((error) => {
					set((paused = true));
					throw error;
				});
			}
		}
	});
}

export function bind_volume(
	media: Media,
	get: () => number | undefined,
	set: (volume: number) => void = get
): void {
	var callback = () => {
		set(media.volume);
	};

	if (get() == null) {
		callback();
	}

	listen(media, ['volumechange'], callback, false);

	render_effect(() => {
		var value = Number(get());

		if (value !== media.volume && !isNaN(value)) {
			media.volume = value;
		}
	});
}

export function bind_muted(
	media: Media,
	get: () => boolean | undefined,
	set: (muted: boolean) => void = get
): void {
	var callback = () => {
		set(media.muted);
	};

	if (get() == null) {
		callback();
	}

	listen(media, ['volumechange'], callback, false);

	render_effect(() => {
		var value = !!get();

		if (media.muted !== value) media.muted = value;
	});
}

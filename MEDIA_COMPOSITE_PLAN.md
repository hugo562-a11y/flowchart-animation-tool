# Reference Media And Composite Export Plan

## Goal

Add a reference-media workflow to the flowchart animation editor so node and
line animation timings can be aligned to a video, narration, or music track.
The editor must continue to support animation-only exports while also offering
an H.264 MP4 export that composites the flowchart animation over a reference
video and preserves the video's original audio.

## User Workflow

1. Import one reference video or audio file.
2. Review the media preview and waveform.
3. Move the shared playhead to align node and line animation clips.
4. Adjust the reference-media start offset when the clip does not begin at
   project time zero.
5. Export animation-only assets or a composite H.264 MP4.

## First Version

- Import one `.mp4`, `.webm`, `.mov`, `.mp3`, or `.wav` file.
- Use a shared playhead for media preview and flowchart animation preview.
- Decode media audio with the Web Audio API and draw a compact waveform track.
- Store media metadata, offset, volume, and mute state in the project JSON.
- Require relinking after reopening a project because browsers cannot silently
  reopen arbitrary local files.
- Generate transparent PNG animation frames in the browser.
- Send the PNG ZIP and selected reference video to the local Python service.
- Use FFmpeg to overlay animation frames, retain source audio, and return a
  fixed-frame-rate H.264 MP4.
- Keep existing Resolve MOV and transparent PNG sequence exports unchanged.

## Data Model

```json
{
  "referenceMedia": {
    "fileName": "sample.mp4",
    "type": "video",
    "duration": 32.5,
    "offset": 0,
    "volume": 0.8,
    "muted": false
  }
}
```

The media file and waveform samples are runtime-only data. They are not
embedded in project JSON or browser local storage.

## Follow-Up Versions

- Cache waveform samples through the Python service for large media files.
- Add marker points, snapping, and keyboard marker shortcuts.
- Generate video thumbnails at adaptive intervals.
- Support media trimming, negative offsets, multiple clips, music, and
  narration tracks.
- Add ProRes composite export and optional hardware-accelerated H.264 encoding.

## Known First-Version Limits

- Composite export accepts a reference video, not an audio-only file.
- The reference-media offset is non-negative.
- Large projects consume browser memory while transparent frames are prepared.
- Local media must be relinked after reopening the browser or loading a project.


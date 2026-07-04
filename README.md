# Chrome bug: Cardboard `immersive-vr` viewer position is derived from the inverted head orientation

**Component:** Blink>WebXR (Chromium `device/vr/android/cardboard`)
**Type:** Bug
**OS:** Android
**Channel:** reproduced on stable; code below is current `main`

## Summary

On Android Chrome's Google Cardboard `immersive-vr` path, the viewer position from
`XRFrame.getViewerPose()` is wrong. The Cardboard SDK runs its 3-DoF neck model on the *inverse* of the
head orientation. Chrome conjugates the orientation — which corrects it — but "fixes" the position by
negating the SDK's vector, and negating a neck model built from the inverse rotation does not recover
the right position. The reported orientation is correct; only the position is affected.

At identity orientation, the position reported by chrome is `[0, 0, +0.08]` ie 8cm *behind* the origin (-Z is forward in WebXR coordinates). The expected position with an identity orientation should be `[0, 0, -0.08]`.

## Live tools

Hosted at **<https://tangobravo.github.io/chrome-cardboard-neck-model-bug/>**.

- **[Recorder](https://tangobravo.github.io/chrome-cardboard-neck-model-bug/record.html)** — open on an Android phone to capture a trace.
- **[Visualizer](https://tangobravo.github.io/chrome-cardboard-neck-model-bug/plot.html)** — inspect a trace in 3D (loads a bundled sample by default).

## Root cause

The Cardboard SDK's `CardboardHeadTracker_getPose` returns an **inverted (view-sense) orientation**
(the reported quaternion is the conjugate of the true head orientation), and its neck model rotates
the neck→eye offset by that same inverted rotation:

```cpp
// SDK: sdk/sensors/neck_model.cc — offset is correct (up + forward, −Z), rotation fed in is not
offset = rotation * Vector3(0, 0.075, -0.08) - Vector3(0, 0.075, 0);   // rotation = inverted orientation
```

Chromium's conversion — [`CardboardRenderLoop::GetFrameData`](https://github.com/chromium/chromium/blob/cfa0b5d0feea0f64cc0402f149eec3e9b7d4b359/device/vr/android/cardboard/cardboard_render_loop.cc#L368-L377)
in `device/vr/android/cardboard/cardboard_render_loop.cc` — compensates for the orientation by
conjugating it — which is correct — but "corrects" the position by simply negating the SDK vector,
which cannot recover the pose position:

```cpp
CardboardHeadTracker_getPose(head_tracker_.get(), timestamp_ns,
                             kViewportOrientation, position, orientation);
pose->orientation = gfx::Quaternion(-orientation[0], -orientation[1], -orientation[2], orientation[3]); // conjugate — OK
pose->position    = gfx::Point3F(-position[0], -position[1], -position[2]);                             // negate — wrong
```

Fitting a recorded trace confirms the reported position exactly (sub-micron), and it factors cleanly
along the code boundary, with `neck_model(r) = R(r)·(0, 0.075, −0.08) − (0, 0.075, 0)`:

```
reported = −neck_model(q⁻¹)     // Cardboard runs the neck model on the inverse rotation; Chrome negates
correct  =  neck_model(q)       // neck model on the true orientation
```

where `q` is the Chrome-reported (correct) orientation. Negating the SDK vector only coincides with `correct`
at ±90° of yaw; elsewhere it is wrong.

## Fix

Keep the orientation conjugation, and derive the position by running the neck model on the **corrected**
orientation rather than negating the SDK vector — replacing the two assignment lines
[at the permalink above](https://github.com/chromium/chromium/blob/cfa0b5d0feea0f64cc0402f149eec3e9b7d4b359/device/vr/android/cardboard/cardboard_render_loop.cc#L368-L377):

```cpp
pose->orientation = gfx::Quaternion(-orientation[0], -orientation[1], -orientation[2], orientation[3]);
pose->position    = Rotate(pose->orientation, gfx::Vector3dF(0, 0.075, -0.08)) - gfx::Vector3dF(0, 0.075, 0);
```

(`ApplyNeckModel` isn't in the public Cardboard C API, so this reimplements its two lines Chrome-side.
Alternatively the SDK could conjugate `out_orientation` before `ApplyNeckModel` and return the
conjugated orientation, but that changes behaviour for native SDK consumers.)

## Reproduction

1. **Record** — open [`record.html`](https://tangobravo.github.io/chrome-cardboard-neck-model-bug/record.html) on an Android phone and enter VR (Google Cardboard).
   A head-locked panel displays `getViewerPose()` position + orientation for both `local` and
   `local-floor` every frame; it also records the trace (~4 samples/sec). Start facing forward at the
   identity orientation, then look up/down, turn, etc. On exit, download the JSON.
   It is dependency-free vanilla WebXR — no frameworks or polyfills — so it shows Chrome's raw pose.
2. **Visualize** — open [`plot.html`](https://tangobravo.github.io/chrome-cardboard-neck-model-bug/plot.html) and load the downloaded trace (it also auto-loads the
   bundled [`sample-trace.json`](https://tangobravo.github.io/chrome-cardboard-neck-model-bug/sample-trace.json)). Plots each eye position in a right-handed, Y-up
   scene with labelled axes and viewing-direction arrows. The **local_fixed** mode reconstructs the
   *correct* neck model from the reported orientation, so you can directly compare it against Chrome's
   reported (buggy) positions — the reported path orbits the wrong side of the neck pivot except when
   facing ±90°. The **invert position** and **invert quaternion** checkboxes let you probe the bug's
   algebra directly: since `reported = −neck_model(q⁻¹)`, negating the position recovers `neck_model(q⁻¹)`
   (a plausible neck-model cap), and conjugating the quaternion pairs it with the inverse rotation it was
   actually built from — tick both to watch a coherent neck model driven by the *wrong* rotations.

`sample-trace.json` is a recorded run (identity → look up/down → turn left 90 degrees → look up/down,
through a full rotation) that the position formulas above fit to sub-micron accuracy.

## Files

- [`record.html`](record.html) — dependency-free WebXR recorder (the repro).
- [`plot.html`](plot.html) + [`plot.js`](plot.js) — three.js visualizer (three.js loaded from a CDN via
  import map; nothing to build).
- [`sample-trace.json`](sample-trace.json) — recorded trace.

/** Which participant belongs in the picture-in-picture window.
 *
 * Only one element can be in PiP at a time, so this has to be a choice rather
 * than a list. A screen share wins outright — it is the thing people put in
 * PiP to keep watching while they work. Otherwise the active speaker, then
 * anyone with video at all. Your own camera is never picked: a floating
 * window of yourself is the one view you do not need.
 */
export function pickPipParticipant(participants) {
  const eligible = participants.filter((p) => !p.isLocal && p.videoTrack);
  if (eligible.length === 0) return null;
  return (
    eligible.find((p) => p.sharingScreen) ??
    eligible.find((p) => p.speaking) ??
    eligible[0]
  );
}

/** Feature detection kept here so the button can be hidden rather than
 * offered and then failing: Firefox exposes no programmatic request API at
 * all, and a disabled-by-policy document reports false. */
export function pipSupported(doc) {
  const target = doc ?? (typeof document === "undefined" ? null : document);
  if (!target) return false;
  return (
    target.pictureInPictureEnabled === true &&
    typeof HTMLVideoElement !== "undefined" &&
    typeof HTMLVideoElement.prototype.requestPictureInPicture === "function"
  );
}

// Which recorded flight to put on screen when one run is shown on its own.
// Every pick is a real recorded (or re-simulated) flight; this only decides
// which of them plays first, so a single click shows a clean success: the
// drone reaches the goal after a visible encounter with the bird.

// Closest approach that reads as "dodged it" on screen: near enough that the
// audience sees the bird threaten, far enough that it clearly missed.
const DODGE = [1.8, 7];

// Score one seed's result: reached with a visible dodge > reached > the rest.
export function seedScore(r) {
  if (!r) return -1;
  if (r.outcome !== "reached") return 0;
  const d = r.minSeparation ?? 99;
  if (d >= DODGE[0] && d <= DODGE[1]) return 3 - d / 100;
  return d > DODGE[1] ? 2 : 1;
}

// Index of the best seed to show for an episode's results.
export function showcaseSeed(results) {
  let best = 0;
  results.forEach((r, i) => {
    if (seedScore(r) > seedScore(results[best])) best = i;
  });
  return best;
}

// Rank whole episodes: most seeds reached, then the best single seed.
export function episodeScore(ep) {
  if (!ep || ep.defender?.invalid) return -1;
  const s = ep.summary;
  return s.reached / s.trials * 10 + seedScore(ep.results[showcaseSeed(ep.results)]);
}

// The best episodes first. Pass a filter to restrict conditions.
export function showcaseEpisodes(episodes, keep = () => true) {
  return episodes.filter((e) => keep(e) && !e.defender?.invalid).sort((a, b) => episodeScore(b) - episodeScore(a));
}

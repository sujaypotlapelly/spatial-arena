// The simulator calls this function once per simulated second. Edit the speed
// or use obs.free_space_m to decide what to do when the direct path is blocked.
function policy(obs, memory) {
  const offset = obs.goal.position.map((target, axis) => target - obs.position[axis]);
  const distance = Math.hypot(...offset);
  const speed = Math.min(3, distance);
  const velocity = distance ? offset.map(delta => speed * delta / distance) : [0, 0, 0];
  return { velocity };
}

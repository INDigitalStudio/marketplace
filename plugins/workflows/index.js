// Wrapper: inject createAgentSession + ui into pi before calling factory
import factory from "./src/extension/index.ts";

export default function (pi) {
  let target = pi;

  // pi is frozen at runtime — create a writable proxy if needed
  if (Object.isFrozen(pi)) {
    target = Object.create(pi);
  }

  // createAgentSession lives on pi.pi, not pi directly
  if (target.createAgentSession === undefined && target.pi?.createAgentSession) {
    target.createAgentSession = target.pi.createAgentSession.bind(target.pi);
  }

  // ui is undefined in omp — inject empty object so installStoreWidget doesn't crash
  if (target.ui === undefined) {
    target.ui = {};
  }

  factory(target);
}

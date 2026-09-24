// TEMP dev harness (removed later)
import { Puppet } from './puppet.js';
import { Rig, defaultParams } from './rig.js';
import { Physics } from './physics.js';
const container = document.getElementById('app');
const puppet = new Puppet({ container, preserveDrawingBuffer: true });
container.append(puppet.canvas);
await puppet.load();
const rig = new Rig(puppet);
const phys = new Physics();
const p = defaultParams();
puppet.resize();
function frame(params = {}) {
  Object.assign(p, defaultParams(), params);
  phys.reset(p);
  rig.update(p);
  puppet.shadow.position.set(0, 0, 0); puppet.shadow.scale.set(0.62, 0.09, 1);
  puppet.logoShadow.visible = false;
  puppet.render();
}
frame();
window.__dev = { frame, puppet, rig, p };
window.__ready = true;

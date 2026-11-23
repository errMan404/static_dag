import { createComponent } from 'solid-js';
import { Dashboard, DetailReturn } from './dashboard.js';
import { installPanel } from '../src/dag_run/tui-controller.js';
// The host calls a route's render function inside its own reactive scope. Calling a component as a plain function
// there makes every signal the component reads while setting up (the run view, refreshed every few seconds) a
// dependency of that scope: the whole page is then rebuilt on each refresh, losing scroll position and selection.
// createComponent runs the setup untracked, as a component is meant to be, so only the bindings inside update.
const mount = Component => props => createComponent(Component, props);
export default { id: 'static-dag.panel', async tui(api) { await installPanel(api, mount(Dashboard), mount(DetailReturn)); } };

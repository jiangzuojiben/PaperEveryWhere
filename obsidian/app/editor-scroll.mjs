// CodeMirror estimates wrapped-line heights before it measures the viewport.
// Assigning scrollTop before that pass lets its scroll anchoring move the saved
// pixel position. Reapply only after completed measure passes, until the target
// viewport is stable. Any new user interaction or document identity cancels it.
export function createScrollRestorer(view, {getIdentity = () => '', onFailure = () => {}} = {}) {
  let pending;
  const finish = (task, restored) => {
    if (pending !== task) return;
    pending = undefined;
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'beforeinput']) view.dom.removeEventListener(name, task.cancel, true);
    task.done?.(restored);
  };
  const cancel = () => { if (pending) finish(pending, false); };
  const restore = (scroll = {}, done) => {
    cancel();
    const element = view.scrollDOM, task = pending = {identity: getIdentity(), doc: view.state.doc, selection: view.state.selection, done, attempts: 0, stable: 0, shape: ''};
    task.cancel = cancel;
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'beforeinput']) view.dom.addEventListener(name, task.cancel, {capture: true, passive: true});
    const apply = () => { if (scroll.top != null) element.scrollTop = scroll.top; if (scroll.left != null) element.scrollLeft = scroll.left; };
    const current = () => pending === task && getIdentity() === task.identity && view.state.doc === task.doc && view.state.selection.eq(task.selection);
    apply();
    if (!element.clientHeight) { finish(task, true); return; }
    const measure = () => view.requestMeasure({key: task, read: () => [element.clientWidth, element.clientHeight, element.scrollWidth, element.scrollHeight].join(':'), write: shape => {
      // CM applies its own anchor compensation after measure.write callbacks.
      // A microtask runs after that pass without writing during a layout read.
      queueMicrotask(() => {
        if (!current()) { finish(task, false); return; }
        const top = scroll.top == null ? element.scrollTop : Math.min(scroll.top, Math.max(0, element.scrollHeight - element.clientHeight));
        const left = scroll.left == null ? element.scrollLeft : Math.min(scroll.left, Math.max(0, element.scrollWidth - element.clientWidth));
        const matches = Math.abs(element.scrollTop - top) <= 1 && Math.abs(element.scrollLeft - left) <= 1;
        task.stable = matches && task.shape === shape ? task.stable + 1 : 0;
        task.shape = shape;
        if (task.stable >= 2) { finish(task, true); return; }
        apply();
        if (++task.attempts >= 12) { onFailure(); finish(task, false); return; }
        measure();
      });
    }});
    measure();
  };
  return {restore, cancel};
}

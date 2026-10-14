const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let dialogCode, actionsCode;
before(async () => {
  await swc.loadBindings();
  async function compile(relative) {
    const filename = path.join(__dirname, relative);
    return (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
  [dialogCode, actionsCode] = await Promise.all([
    compile("../components/QueueTicketDialog.js"), compile("../components/QueueTicketActions.js")
  ]);
});

function ticket(status = "waiting") {
  return { patientId: 12, queueNumber: "OB-002", serviceLabel: "Prenatal", doctorName: "Doctor 2",
    registeredDate: "Oct 13, 2026", registeredTime: "8:15 AM", status,
    statusLabel: status === "waiting" ? "Waiting" : status === "completed" ? "Completed" : "Cancelled",
    isActive: status === "waiting" || status === "serving" };
}

function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) tree.forEach(node => nodes(node, predicate, found));
  else if (tree && typeof tree === "object") {
    if (predicate(tree)) found.push(tree);
    nodes(tree.props?.children, predicate, found);
  }
  return found;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props?.children);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}

function actionsHarness(props, ticketApi) {
  const slots = [], cleanups = [];
  let cursor = 0;
  const react = {
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }];
    },
    useEffect(effect) { if (!cleanups.length) cleanups.push(effect()); }
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  vm.runInNewContext(actionsCode, {
    module, exports: module.exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "../lib/queueTicket") return ticketApi;
      throw new Error(`Unexpected Actions import ${name}`);
    }
  });
  let tree;
  function render() { cursor = 0; tree = module.exports.default(props); return tree; }
  render();
  return {
    render,
    button(label) { return nodes(tree, node => node.type === "button" && text(node) === label)[0]; },
    get tree() { return tree; },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); }
  };
}

// Model hook effects, native dialog calls and timers without needing a browser or database.
function harness(initialProps = {}) {
  const slots = [], requests = [], timers = new Map(), printed = [], popups = [];
  const Pass = function DigitalQueuePass() {};
  const Actions = function QueueTicketActions() {};
  let cursor = 0, dirty = false, mounted = true, tree, effects = [], now = 0, timerId = 0;
  let lateWrites = 0, focusRestores = 0, modalOpens = 0, dialogCloses = 0, fullscreenRequests = 0, dialogFullscreenAttempts = 0;
  let props = { ticket: ticket(), onClose() {}, ...initialProps };
  const previousFocus = { isConnected: true, focus() { focusRestores++; } };
  const document = { activeElement: previousFocus, fullscreenEnabled: true, fullscreenElement: null,
    async exitFullscreen() { document.fullscreenElement = null; } };
  const dialog = { open: false,
    showModal() { this.open = true; modalOpens++; },
    close() { this.open = false; dialogCloses++; },
    async requestFullscreen() {
      dialogFullscreenAttempts++;
      throw new TypeError("The Fullscreen API does not support dialog elements");
    } };
  const fullscreenTarget = {
    async requestFullscreen() { fullscreenRequests++; document.fullscreenElement = this; }
  };
  const react = {
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: initial };
      return [slots[index].value, update => {
        if (!mounted) lateWrites++;
        const next = typeof update === "function" ? update(slots[index].value) : update;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const slot = slots[index];
      const changed = !slot || dependencies.some((value, i) => !Object.is(value, slot.dependencies[i]));
      if (changed) {
        slots[index] = { dependencies, cleanup: slot?.cleanup };
        effects.push(() => {
          slots[index].cleanup?.();
          slots[index].cleanup = effect();
        });
      }
    }
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  function enqueueRequest(patientId, source) {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    requests.push({ patientId, source, resolve, reject });
    return promise;
  }
  const module = { exports: {} };
  vm.runInNewContext(dialogCode, {
    module, exports: module.exports, document,
    setTimeout(callback, milliseconds) {
      const id = ++timerId;
      timers.set(id, { callback, at: now + milliseconds });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "./DigitalQueuePass") return { __esModule: true, default: Pass };
      if (name === "./QueueTicketActions") return { __esModule: true, default: Actions };
      if (name === "../lib/queueTicket") return { fetchExistingQueueTicket: patientId => enqueueRequest(patientId, "dialog") };
      throw new Error(`Unexpected import ${name}`);
    }
  });

  function render(changes) {
    if (changes) props = { ...props, ...changes };
    let count = 0;
    do {
      assert.ok(count++ < 20, "hook renders should settle");
      dirty = false;
      cursor = 0;
      tree = module.exports.default(props);
      for (const node of nodes(tree, node => node.type === "dialog")) node.props.ref.current = dialog;
      for (const node of nodes(tree, node => node.type === "div" && node.props.className === "queue-ticket-dialog__content")) node.props.ref.current = fullscreenTarget;
      const pending = effects;
      effects = [];
      pending.forEach(effect => effect());
    } while (dirty);
    return tree;
  }
  const h = {
    render, requests, document, dialog, fullscreenTarget, timers, printed, popups,
    get tree() { return tree; },
    get lateWrites() { return lateWrites; },
    get focusRestores() { return focusRestores; },
    get modalOpens() { return modalOpens; },
    get dialogCloses() { return dialogCloses; },
    get fullscreenRequests() { return fullscreenRequests; },
    get dialogFullscreenAttempts() { return dialogFullscreenAttempts; },
    passes() { return nodes(tree, node => node.type === Pass); },
    actions() { return nodes(tree, node => node.type === Actions); },
    delivery() {
      return actionsHarness(h.actions()[0].props, {
        fetchExistingQueueTicket: patientId => enqueueRequest(patientId, "delivery"),
        openThermalTicketWindow() {
          const popup = { closed: false, close() { this.closed = true; } };
          popups.push(popup);
          return popup;
        },
        printQueueTicket: (ticket, popup) => { printed.push(ticket); assert.equal(popup, popups[popups.length - 1]); },
        downloadQueueTicket: async () => true
      });
    },
    button(label) { return nodes(tree, node => node.type === "button" && text(node) === label)[0]; },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of Array.from(timers)) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
      render();
    },
    // SWC-transformed async functions can cross several promise jobs/realms.
    // Drain the event-loop turn rather than assuming a fixed microtask count.
    async settle() { await new Promise(resolve => setImmediate(resolve)); render(); },
    unmount() {
      mounted = false;
      slots.forEach(slot => slot?.cleanup?.());
      tree = null;
    }
  };
  render();
  return h;
}

test("opening verifies the saved ID before showing any pass or delivery action", async () => {
  const h = harness();
  assert.equal(h.modalOpens, 1);
  assert.equal(h.dialog.open, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].patientId, 12);
  assert.equal(h.passes().length, 0);
  assert.equal(h.actions().length, 0);
  assert.equal(h.button("Photo Mode").props.disabled, true);
  assert.match(text(h.tree), /Verifying the saved queue ticket/);
  h.requests[0].resolve(ticket("completed"));
  await h.settle();
  assert.equal(h.passes()[0].props.ticket.status, "completed");
  assert.equal(h.passes()[0].props.ticket.queueNumber, "OB-002");
  assert.equal(h.actions()[0].props.ticket, h.passes()[0].props.ticket);
  assert.equal(h.button("Photo Mode").props.disabled, false);
  assert.equal(h.timers.size, 1);
  h.unmount();
});

test("initial verification failure hides the pass; explicit retry revalidates without duplicate reads", async () => {
  const h = harness();
  h.requests[0].reject(new Error("Permission denied"));
  await h.settle();
  assert.match(text(h.tree), /Permission denied/);
  assert.equal(h.passes().length, 0);
  assert.equal(h.actions().length, 0);
  const retry = h.button("Retry Verification");
  assert.equal(retry.props.disabled, false);
  retry.props.onClick();
  retry.props.onClick();
  h.render();
  assert.equal(h.requests.length, 2);
  assert.equal(h.button("Retry Verification").props.disabled, true);
  h.advance(10000);
  assert.equal(h.requests.length, 2, "there is no overlapping poll while retry is pending");
  h.requests[1].resolve(ticket());
  await h.settle();
  assert.equal(h.passes().length, 1);
  assert.equal(h.button("Retry Verification"), undefined);
  h.unmount();
});

test("5-second status refresh updates Photo Mode without adding background loading controls", async () => {
  const h = harness();
  h.requests[0].resolve(ticket());
  await h.settle();
  h.button("Photo Mode").props.onClick();
  h.render();
  assert.equal(h.actions().length, 0);
  assert.equal(h.button("Full Screen"), undefined);
  assert.ok(!text(h.tree).includes("Photograph this pass from the monitor"));
  assert.equal(h.button("Exit Photo Mode").props.disabled, false);
  assert.ok(h.button("Close"));
  const passArea = nodes(h.tree, node => node.props.className === "queue-ticket-dialog__ticket")[0];
  assert.equal(nodes(passArea, node => node.type === "button").length, 0, "controls are outside the photographed ticket");
  h.advance(4999);
  assert.equal(h.requests.length, 1);
  h.advance(1);
  assert.equal(h.requests.length, 2);
  assert.ok(!text(h.tree).includes("Verifying the saved queue ticket"));
  assert.equal(h.button("Exit Photo Mode").props.disabled, false);
  h.advance(5000);
  assert.equal(h.requests.length, 2, "slow reads do not overlap");
  h.requests[1].resolve(ticket("completed"));
  await h.settle();
  assert.equal(h.passes()[0].props.ticket.status, "completed");
  assert.equal(h.passes()[0].props.ticket.isActive, false);
  h.button("Exit Photo Mode").props.onClick();
  h.render();
  assert.equal(h.actions()[0].props.ticket.status, "completed");
  h.unmount();
});

test("a failed background read removes stale validity and the next poll can recover", async () => {
  const h = harness();
  h.requests[0].resolve(ticket());
  await h.settle();
  h.advance(5000);
  h.requests[1].reject(new Error("Ticket information could not be verified"));
  await h.settle();
  assert.equal(h.passes().length, 0);
  assert.equal(h.actions().length, 0);
  assert.equal(h.button("Photo Mode").props.disabled, true);
  assert.match(text(h.tree), /could not be verified/);
  h.render({ ticket: ticket("completed") });
  assert.equal(h.passes().length, 0, "a parent row cannot replace a failed authenticated verification");
  h.advance(5000);
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve(ticket("completed"));
  await h.settle();
  assert.equal(h.passes()[0].props.ticket.status, "completed");
  assert.ok(!text(h.tree).includes("could not be verified"));
  h.unmount();
});

test("parent table props cannot replace this dialog's verified status", async () => {
  const h = harness();
  h.requests[0].resolve(ticket());
  await h.settle();
  h.advance(5000);
  h.requests[1].resolve(ticket("completed"));
  await h.settle();
  h.render({ ticket: ticket() });
  assert.equal(h.passes()[0].props.ticket.status, "completed", "an older waiting parent poll cannot make a completed ticket active");
  assert.equal(h.passes()[0].props.ticket.isActive, false);
  assert.equal(h.actions()[0].props.ticket.status, "completed");
  h.render({ ticket: ticket("cancelled") });
  assert.equal(h.passes()[0].props.ticket.status, "completed", "all parent status props must await this session's authenticated verification");
  h.unmount();
});

test("older dialog polls cannot overwrite refreshed delivery results", async () => {
  let reconciled;
  const h = harness({ onTicketUpdate: fresh => { reconciled = fresh; } });
  h.requests[0].resolve(ticket());
  await h.settle();
  h.advance(5000);
  const delivered = ticket("completed");
  h.actions()[0].props.onTicketUpdate(delivered);
  h.render();
  h.requests[1].resolve(ticket());
  await h.settle();
  assert.equal(h.passes()[0].props.ticket.status, "completed");
  assert.equal(reconciled, delivered);
  h.advance(5000);
  const cancelled = ticket("cancelled");
  h.actions()[0].props.onTicketUpdate(cancelled);
  h.render();
  h.requests[2].reject(new Error("Older failed read"));
  await h.settle();
  assert.equal(h.passes()[0].props.ticket.status, "cancelled");
  assert.equal(reconciled, cancelled);
  assert.ok(!text(h.tree).includes("Older failed read"));
  h.unmount();
});

test("delivery verification prevents a later periodic read from overtaking and then resumes polling", async () => {
  const h = harness();
  h.requests[0].resolve(ticket());
  await h.settle();
  const delivery = h.delivery();
  const pending = delivery.button("Print Thermal Ticket").props.onClick();
  assert.equal(h.requests[1].source, "delivery");
  h.advance(10000);
  assert.equal(h.requests.length, 2, "a later periodic GET must not start while the delivery GET is pending");
  h.requests[1].resolve(ticket());
  await pending;
  await h.settle();
  assert.equal(h.printed.length, 1);
  h.advance(4999);
  assert.equal(h.requests.length, 2);
  h.advance(1);
  assert.equal(h.requests[2].source, "dialog", "periodic verification resumes after delivery");
  h.requests[2].resolve(ticket("completed"));
  await h.settle();
  assert.equal(h.passes()[0].props.ticket.status, "completed");
  assert.equal(h.passes()[0].props.ticket.isActive, false);
  delivery.unmount();
  h.unmount();
});

test("a failed delivery closes its popup and releases periodic verification", async () => {
  const h = harness();
  h.requests[0].resolve(ticket());
  await h.settle();
  const delivery = h.delivery();
  const pending = delivery.button("Print Thermal Ticket").props.onClick();
  h.advance(5000);
  assert.equal(h.requests.length, 2);
  h.requests[1].reject(new Error("Ticket verification unavailable"));
  await pending;
  delivery.render();
  assert.match(text(delivery.tree), /verification unavailable/);
  assert.equal(h.popups[0].closed, true);
  assert.equal(h.printed.length, 0);
  h.advance(5000);
  assert.equal(h.requests[2].source, "dialog");
  h.requests[2].resolve(ticket("completed"));
  await h.settle();
  assert.equal(h.passes()[0].props.ticket.status, "completed");
  delivery.unmount();
  h.unmount();
});

test("Actions unmount resumes polling and its delayed older response cannot restore waiting status", async () => {
  const h = harness();
  h.requests[0].resolve(ticket());
  await h.settle();
  const delivery = h.delivery();
  const pending = delivery.button("Print Thermal Ticket").props.onClick();
  h.advance(5000);
  assert.equal(h.requests.length, 2);
  delivery.unmount();
  assert.equal(h.popups[0].closed, true);
  h.advance(5000);
  assert.equal(h.requests[2].source, "dialog");
  h.requests[2].resolve(ticket("completed"));
  await h.settle();
  h.requests[1].resolve(ticket());
  await pending;
  await h.settle();
  assert.equal(h.printed.length, 0);
  assert.equal(h.passes()[0].props.ticket.status, "completed");
  assert.equal(h.passes()[0].props.ticket.isActive, false);
  assert.equal(h.timers.size, 1, "late delivery cleanup does not duplicate the resumed timer");
  h.unmount();
});

test("a periodic read started before delivery cannot overwrite its freshly verified result", async () => {
  const h = harness();
  h.requests[0].resolve(ticket());
  await h.settle();
  h.advance(5000);
  assert.equal(h.requests[1].source, "dialog");
  const delivery = h.delivery();
  const pending = delivery.button("Print Thermal Ticket").props.onClick();
  assert.equal(h.requests[2].source, "delivery");
  h.requests[2].resolve(ticket("completed"));
  await pending;
  await h.settle();
  assert.equal(h.printed[0].status, "completed");
  assert.equal(h.passes()[0].props.ticket.status, "completed");
  h.requests[1].resolve(ticket());
  await h.settle();
  assert.equal(h.passes()[0].props.ticket.status, "completed");
  assert.equal(h.timers.size, 1);
  delivery.unmount();
  h.unmount();
});

test("native Full Screen targets eligible content, enables Photo Mode, and cleans up modal focus on close", async () => {
  let closed = 0, prevented = 0;
  const h = harness({ onClose: () => { throw new Error("old callback should not be called"); } });
  h.requests[0].resolve(ticket());
  await h.settle();
  h.render({ onClose: () => { closed++; } });
  await h.button("Full Screen").props.onClick();
  h.render();
  assert.equal(h.fullscreenRequests, 1);
  assert.equal(h.dialogFullscreenAttempts, 0, "dialog elements must never be fullscreen targets");
  assert.equal(h.document.fullscreenElement, h.fullscreenTarget);
  assert.equal(h.actions().length, 0);
  assert.ok(h.button("Exit Photo Mode"));
  h.tree.props.onCancel({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(closed, 1);
  h.render({ ticket: null });
  assert.equal(h.dialogCloses, 1);
  assert.equal(h.focusRestores, 1);
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.timers.size, 0);
  h.unmount();
});

test("Exit Photo Mode exits native fullscreen while preserving the open dialog and delivery actions", async () => {
  const h = harness();
  h.requests[0].resolve(ticket());
  await h.settle();
  await h.button("Full Screen").props.onClick();
  h.render();
  h.button("Exit Photo Mode").props.onClick();
  h.render();
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.dialog.open, true);
  assert.equal(h.actions().length, 1);
  assert.ok(h.button("Photo Mode"));
  h.unmount();
});

test("a fullscreen request completing after close exits fullscreen without late state writes", async () => {
  const h = harness();
  h.requests[0].resolve(ticket());
  await h.settle();
  let resolve;
  h.fullscreenTarget.requestFullscreen = () => new Promise(done => {
    resolve = () => { h.document.fullscreenElement = h.fullscreenTarget; done(); };
  });
  const pending = h.button("Full Screen").props.onClick();
  h.unmount();
  resolve();
  await pending;
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.lateWrites, 0);
});

test("unmount cancels timers and late poll/delivery updates while restoring the opener focus", async () => {
  const h = harness();
  h.requests[0].resolve(ticket());
  await h.settle();
  const lateDelivery = h.actions()[0].props.onTicketUpdate;
  h.advance(5000);
  h.unmount();
  assert.equal(h.dialogCloses, 1);
  assert.equal(h.focusRestores, 1);
  h.requests[1].resolve(ticket("completed"));
  await new Promise(resolve => setImmediate(resolve));
  lateDelivery(ticket("cancelled"));
  assert.equal(h.lateWrites, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.length, 2);
});

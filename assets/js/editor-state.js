/* PDF editor state: objects, page operations, selection, undo/redo history.
 *
 * Object model (all geometry in PDF points, origin bottom-left):
 *   {id: "edit-N", type, pageKey, ...type fields}
 * pageKey is stable ("p0", "p1", ... or "blank-N"); manifest build maps it
 * to the FINAL 1-based page number after pageOps. History stores full
 * snapshots {objects, pageOps} (cap 100) — never reloads the PDF for undo.
 */
window.PdfEditorState = (function () {
  var MAX_HISTORY = 100;

  function create() {
    return {
      objects: [],
      pageOps: [],
      selectedId: null,
      uidCounter: 0,
      blankCounter: 0,
      past: [],
      future: []
    };
  }

  function snapshot(state) {
    return {
      objects: JSON.parse(JSON.stringify(state.objects)),
      pageOps: JSON.parse(JSON.stringify(state.pageOps))
    };
  }

  function commit(state) {
    state.past.push(snapshot(state));
    if (state.past.length > MAX_HISTORY) state.past.shift();
    state.future.length = 0;
  }

  function undo(state) {
    if (!state.past.length) return false;
    state.future.push(snapshot(state));
    var prev = state.past.pop();
    state.objects = prev.objects;
    state.pageOps = prev.pageOps;
    if (!state.objects.some(function (o) { return o.id === state.selectedId; })) {
      state.selectedId = null;
    }
    return true;
  }

  function redo(state) {
    if (!state.future.length) return false;
    state.past.push(snapshot(state));
    var next = state.future.pop();
    state.objects = next.objects;
    state.pageOps = next.pageOps;
    if (!state.objects.some(function (o) { return o.id === state.selectedId; })) {
      state.selectedId = null;
    }
    return true;
  }

  function nextId(state) {
    state.uidCounter += 1;
    return "edit-" + state.uidCounter;
  }

  function addObject(state, obj) {
    commit(state);
    if (!obj.id) obj.id = nextId(state);
    state.objects.push(obj);
    state.selectedId = obj.id;
    return obj;
  }

  function removeObject(state, id) {
    var idx = state.objects.findIndex(function (o) { return o.id === id; });
    if (idx < 0) return false;
    commit(state);
    state.objects.splice(idx, 1);
    if (state.selectedId === id) state.selectedId = null;
    return true;
  }

  function getObject(state, id) {
    return state.objects.find(function (o) { return o.id === id; }) || null;
  }

  function touch(state) {
    commit(state);
  }

  function clear(state) {
    state.objects = [];
    state.pageOps = [];
    state.selectedId = null;
    state.uidCounter = 0;
    state.blankCounter = 0;
    state.past = [];
    state.future = [];
  }

  function objectCount(state) {
    return state.objects.length;
  }

  /* Apply pageOps to an ordered key list; mirrors backend apply_page_ops
   * (keys only, no geometry). Returns {order: [keys], rotations: {key: deg}}.
   * Throws on out-of-range ops (caller surfaces a friendly error). */
  function applyOpsToKeys(keys, pageOps) {
    var order = keys.slice();
    var rotations = {};
    order.forEach(function (k) { rotations[k] = 0; });
    (pageOps || []).forEach(function (op) {
      var count = order.length, idx;
      if (op.action === "rotate" || op.action === "delete" || op.action === "move") {
        idx = op.page - 1;
        if (idx < 0 || idx >= count) {
          throw new Error("Page " + op.page + " does not exist.");
        }
      }
      if (op.action === "rotate") {
        rotations[order[idx]] = ((rotations[order[idx]] + op.angle) % 360 + 360) % 360;
      } else if (op.action === "delete") {
        if (count === 1) throw new Error("Cannot delete the only page.");
        delete rotations[order[idx]];
        order.splice(idx, 1);
      } else if (op.action === "move") {
        if (op.to < 1 || op.to > count) {
          throw new Error("Position " + op.to + " is out of range.");
        }
        var item = order.splice(idx, 1)[0];
        order.splice(op.to - 1, 0, item);
      } else if (op.action === "insert_blank") {
        if (op.at < 1 || op.at > count + 1) {
          throw new Error("Position " + op.at + " is out of range.");
        }
        var key = op.key; // assigned by the app when created
        order.splice(op.at - 1, 0, key);
        rotations[key] = 0;
      } else {
        throw new Error("Unknown page action.");
      }
    });
    return { order: order, rotations: rotations };
  }

  function newBlankKey(state) {
    state.blankCounter += 1;
    return "blank-" + state.blankCounter;
  }

  return {
    MAX_HISTORY: MAX_HISTORY,
    create: create,
    commit: commit,
    undo: undo,
    redo: redo,
    nextId: nextId,
    addObject: addObject,
    removeObject: removeObject,
    getObject: getObject,
    touch: touch,
    clear: clear,
    objectCount: objectCount,
    applyOpsToKeys: applyOpsToKeys,
    newBlankKey: newBlankKey
  };
})();

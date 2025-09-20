// ==UserScript==
// @name         NovelAI Prompt Weight Wrapper (Zero-Unwrap)
// @namespace    http://tampermonkey.net/
// @version      0.5
// @description  1.1::word:: wrapper with Ctrl+Up/Down; caret-safe; unwrap tag when weight reaches 0.0
// @match        https://novelai.net/image*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const WEIGHT_STEP = 0.1;
  const NEW_PREFIX = '1.1::';
  const NEW_SUFFIX = '::';
  const TAG_RE = /(\d+(?:\.\d+)?)(::?):([^:]+?)::/g; // supports 1.2::word:: and legacy 1.2:word::

  function isBoundaryChar(ch) {
    return /[\s\n\r\t.,;:!?()\[\]{}"'`]/.test(ch);
  }

  function getEditableElement() {
    const a = document.activeElement;
    if (!a) return null;
    if (a.tagName === 'TEXTAREA') return a;
    if (a.tagName === 'INPUT' && a.type === 'text') return a;
    if (a.isContentEditable) return a;
    return null;
  }

  function expandToWord(text, index) {
    let s = index, e = index;
    while (s > 0 && !isBoundaryChar(text[s - 1])) s--;
    while (e < text.length && !isBoundaryChar(text[e])) e++;
    return [s, e];
  }

  function findTagByRange(text, start, end) {
    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(text)) !== null) {
      const tagStart = m.index;
      const tagEnd   = TAG_RE.lastIndex;
      if (start >= tagStart && end <= tagEnd) {
        return { tagStart, tagEnd, weight: parseFloat(m[1]), inner: m[3] };
      }
    }
    return null;
  }

  function findTagByCaret(text, index) {
    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(text)) !== null) {
      const tagStart = m.index;
      const tagEnd   = TAG_RE.lastIndex;
      if (index >= tagStart && index <= tagEnd) {
        return { tagStart, tagEnd, weight: parseFloat(m[1]), inner: m[3] };
      }
    }
    return null;
  }

  function formatTag(weight, inner) {
    return `${weight.toFixed(1)}::${inner}::`;
  }

  // ---- contentEditable caret helpers ----
  function setCaretByOffset(rootEl, offset) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null, false);
    let acc = 0, node = null, nodeOffset = 0;
    while (walker.nextNode()) {
      const t = walker.currentNode;
      const len = t.textContent.length;
      if (acc + len >= offset) {
        node = t;
        nodeOffset = offset - acc;
        break;
      }
      acc += len;
    }
    if (!node) return;
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(node, nodeOffset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function computeRangeOffsets(rootEl, range) {
    const pre = range.cloneRange();
    pre.selectNodeContents(rootEl);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;

    const pre2 = range.cloneRange();
    pre2.selectNodeContents(rootEl);
    pre2.setEnd(range.endContainer, range.endOffset);
    const end = pre2.toString().length;

    return [Math.min(start, end), Math.max(start, end)];
  }

  // Core edit logic that now unwraps when newWeight == 0.0
  function adjustString(text, selStart, selEnd, increase) {
    let start = selStart, end = selEnd;

    // If collapsed, expand to word; if still empty, try tag at caret
    if (start === end) {
      [start, end] = expandToWord(text, start);
      if (start === end) {
        const t = findTagByCaret(text, selStart);
        if (!t) return { newText: text, caret: selStart };
        let newWeight = Math.round((t.weight + (increase ? WEIGHT_STEP : -WEIGHT_STEP)) * 10) / 10;
        if (newWeight <= 0) {
          // Unwrap: remove markup, keep inner
          const before = text.slice(0, t.tagStart);
          const after  = text.slice(t.tagEnd);
          const newText = before + t.inner + after;
          const caret = (before + t.inner).length;
          return { newText, caret };
        } else {
          newWeight = Math.max(0, newWeight);
          const before = text.slice(0, t.tagStart);
          const after  = text.slice(t.tagEnd);
          const updated = formatTag(newWeight, t.inner);
          const newText = before + updated + after;
          const caret = (before + updated).length;
          return { newText, caret };
        }
      }
    }

    // Non-empty selection: try adjust tag covering range
    const tag = findTagByRange(text, start, end);
    if (tag) {
      let newWeight = Math.round((tag.weight + (increase ? WEIGHT_STEP : -WEIGHT_STEP)) * 10) / 10;
      if (newWeight <= 0) {
        // Unwrap tag entirely
        const before = text.slice(0, tag.tagStart);
        const after  = text.slice(tag.tagEnd);
        const newText = before + tag.inner + after;
        const caret = (before + tag.inner).length;
        return { newText, caret };
      } else {
        newWeight = Math.max(0, newWeight);
        const before = text.slice(0, tag.tagStart);
        const after  = text.slice(tag.tagEnd);
        const updated = formatTag(newWeight, tag.inner);
        const newText = before + updated + after;
        const caret = (before + updated).length;
        return { newText, caret };
      }
    }

    // Otherwise insert a new tag around selected word
    const word = text.slice(start, end);
    if (!word) return { newText: text, caret: selStart };
    const before = text.slice(0, start);
    const after  = text.slice(end);
    const inserted = NEW_PREFIX + word + NEW_SUFFIX;
    const newText = before + inserted + after;
    const caret = (before + inserted).length;
    return { newText, caret };
  }

  function adjustInPlain(el, increase) {
    const prevScroll = el.scrollTop;
    const { newText, caret } = adjustString(el.value, el.selectionStart, el.selectionEnd, increase);
    if (newText === el.value) return;
    el.value = newText;
    el.setSelectionRange(caret, caret);
    el.scrollTop = prevScroll;
  }

  function adjustInContentEditable(el, increase) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const text = el.innerText || el.textContent || '';
    const [s, e] = computeRangeOffsets(el, range);

    const { newText, caret } = adjustString(text, s, e, increase);
    if (newText === text) return;
    el.innerText = newText;
    setCaretByOffset(el, caret);
  }

  function updateWeight(increase) {
    const el = getEditableElement();
    if (!el) return;
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) {
      adjustInPlain(el, increase);
    } else if (el.isContentEditable) {
      adjustInContentEditable(el, increase);
    }
  }

  document.addEventListener('keydown', function (e) {
    if (!e.ctrlKey) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      updateWeight(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      updateWeight(false);
    }
  });
})();

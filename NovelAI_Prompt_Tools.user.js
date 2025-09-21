// ==UserScript==
// @name         NovelAI Prompt Tools
// @namespace    http://tampermonkey.net/
// @version      3.9.6
// @description  A simple Tampermonkey userscript for NovelAI Image Generator that makes prompting more easieral-time tag suggester. Toggle suggester in settings. Shows a welcome message on first install.
// @match        https://novelai.net/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';

  /* ---------------------- STORAGE (Weight Wrapper) ---------------------- */
  const LS_KEY = 'nwpw_config_v3'; // v3 includes suggester toggle
  const POS_KEY = 'nwpw_panel_pos';
  const FIRST_RUN_KEY = 'nwpw_first_run_v3.9'; // Updated for new popup logic
  const LEGACY_KEY_V1 = 'nwpw_config_v1';
  const LEGACY_KEY_V2 = 'nwpw_config_v2';


  const DEFAULTS = {
    weightStep: 0.1,
    insertUpWeight: 1.1,
    insertDownWeight: 0.9,
    increaseHotkey: { key: 'ArrowUp',   ctrl: true,  alt: false, shift: false },
    decreaseHotkey: { key: 'ArrowDown', ctrl: true,  alt: false, shift: false },
    toggleUIHotkey: { key: ';',         ctrl: true,  alt: false, shift: false }, // Ctrl+;
    enableTagSuggester: false, // Feature is disabled by default
  };

  function migrateLegacy() {
    // Check for v2 first
    let raw = localStorage.getItem(LEGACY_KEY_V2);
    if(raw) {
        try {
            const old = JSON.parse(raw);
            return { ...DEFAULTS, ...old }; // Carry over old settings
        } catch {}
    }
    // Then check for v1
    raw = localStorage.getItem(LEGACY_KEY_V1);
    if (raw) {
      try {
        const old = JSON.parse(raw);
        return {
          ...DEFAULTS,
          weightStep: old.weightStep ?? DEFAULTS.weightStep,
          insertUpWeight: old.insertUpWeight ?? DEFAULTS.insertUpWeight,
          insertDownWeight: old.insertDownWeight ?? DEFAULTS.insertDownWeight,
          increaseHotkey: { key: old.increaseKey || DEFAULTS.increaseHotkey.key, ctrl: !!old.requireCtrl, alt: !!old.requireAlt, shift: !!old.requireShift },
          decreaseHotkey: { key: old.decreaseKey || DEFAULTS.decreaseKey.key, ctrl: !!old.requireCtrl, alt: !!old.requireAlt, shift: !!old.requireShift },
          toggleUIHotkey: old.toggleUIHotkey || DEFAULTS.toggleUIHotkey,
        };
      } catch {}
    }
    return null;
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
      const migrated = migrateLegacy();
      if (migrated) {
        localStorage.setItem(LS_KEY, JSON.stringify(migrated));
        // Clean up old keys
        localStorage.removeItem(LEGACY_KEY_V1);
        localStorage.removeItem(LEGACY_KEY_V2);
        return migrated;
      }
      return { ...DEFAULTS };
    } catch { return { ...DEFAULTS }; }
  }
  function saveConfig(cfg) { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }

  let CONFIG = loadConfig();


  /* ================================================================================= */
  /* ---------------------- TAG SUGGESTER CORE ---------------------- */
  /* ================================================================================= */

    const TAG_DATA_URL = 'https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/refs/heads/main/tags/danbooru_e621_merged.csv';
    let allTags = [];
    let aliasMap = new Map();
    let autocompleteContext = null; // To store position of tag being autocompleted
    let isAdjustingWeight = false; // Flag to prevent suggestions during weight adjustment

    function parseCsvLine(line) {
        const regex = /(".*?"|[^",]+)(?=\s*,|\s*$)/g;
        const matches = line.match(regex) || [];
        return matches.map(field => field.replace(/^"|"$/g, '').trim());
    }

    function fetchTags() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: TAG_DATA_URL,
            onload: function(response) {
                const lines = response.responseText.split('\n');
                const rawTags = [];
                const aliasCandidates = new Map();

                lines.forEach(line => {
                    if (!line) return;
                    const parts = parseCsvLine(line);
                    if (parts.length < 1 || !parts[0]) return;
                    const tag = { text: parts[0], category: parts[1], count: parseInt(parts[2], 10) || 0, aliases: parts[3] || "" };
                    rawTags.push(tag);
                });

                for (const tag of rawTags) {
                    if (tag.aliases) {
                        const aliases = tag.aliases.split(',').map(a => a.trim().replace(/^\//, ''));
                        aliases.forEach(alias => {
                            if (alias && alias !== tag.text) {
                                const existingCandidate = aliasCandidates.get(alias);
                                if (!existingCandidate || tag.count > existingCandidate.count) {
                                    aliasCandidates.set(alias, { mainTag: tag.text, count: tag.count });
                                }
                            }
                        });
                    }
                }

                allTags = rawTags;
                aliasCandidates.forEach((value, key) => aliasMap.set(key, value.mainTag));

                const mainTagTexts = new Set(allTags.map(t => t.text));
                for (const tagText of mainTagTexts) {
                    if (aliasMap.has(tagText)) aliasMap.delete(tagText);
                }
                console.log(`[Tag Suggester] Loaded ${allTags.length} tags and ${aliasMap.size} aliases.`);
            },
            onerror: function(error) { console.error('[Tag Suggester] Failed to fetch tags:', error); }
        });
    }

    const suggestionContainer = document.createElement('div');
    suggestionContainer.id = 'tag-suggestions-container';
    let activeInput = null;
    let currentSuggestions = [];
    let highlightedIndex = -1;
    let debounceTimer;

    function runAutocomplete(textArea) {
        if (!CONFIG.enableTagSuggester) return;
        const isCE = textArea.isContentEditable;
        const text = isCE ? textArea.textContent : textArea.value;
        const sel = window.getSelection();
        if (isCE && sel.rangeCount === 0) return;

        // FIX: Use computeRangeOffsets for contentEditable elements to get the correct cursor position
        // even when there are multiple child nodes (e.g., from syntax highlighting).
        const [cursorPos, selectionEnd] = isCE
            ? computeRangeOffsets(textArea, sel.getRangeAt(0))
            : [textArea.selectionStart, textArea.selectionEnd];

        if (text.length === 0) {
            hideSuggestions();
            autocompleteContext = null;
            return;
        }

        let searchWord, contextStart, contextEnd;
        const tagInfo = findTagByCaret(text, cursorPos);

        if (tagInfo) {
            searchWord = tagInfo.inner;
            contextStart = tagInfo.tagStart;
            contextEnd = tagInfo.tagEnd;
        } else {
            let groupStart = text.lastIndexOf(',', cursorPos - 1) + 1;
            let groupEnd = text.indexOf(',', cursorPos);
            if (groupEnd === -1) groupEnd = text.length;

            while (/\s/.test(text[groupStart])) groupStart++;

            contextStart = groupStart;
            contextEnd = groupEnd;
            searchWord = text.substring(groupStart, cursorPos).trim();
        }

        const tagword = searchWord.trim();
        if (tagword.length === 0 || (!tagInfo && /^\d+(\.\d*)?$/.test(tagword))) {
            hideSuggestions();
            autocompleteContext = null;
            return;
        }

        autocompleteContext = { start: contextStart, end: contextEnd };

        const suggestions = getSuggestions(tagword);
        currentSuggestions = suggestions;
        if (suggestions.length > 0) {
            showSuggestions(suggestions, textArea, tagword);
        } else {
            hideSuggestions();
        }
    }

    function getSuggestions(query) {
        const queryLower = query.toLowerCase().replace(/ /g, '_');
        const searchRegex = new RegExp(`^${queryLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
        const seen = new Set();
        const results = [];

        for (const tag of allTags) {
            if (searchRegex.test(tag.text.toLowerCase())) {
                if (!seen.has(tag.text)) {
                    results.push({ ...tag, source: tag.text });
                    seen.add(tag.text);
                }
            }
        }
        for (const [alias, correctTagText] of aliasMap.entries()) {
             if (searchRegex.test(alias.toLowerCase())) {
                 if (!seen.has(correctTagText)) {
                     const originalTag = allTags.find(t => t.text === correctTagText);
                     if (originalTag) {
                         results.push({ ...originalTag, source: alias, isAlias: true });
                         seen.add(correctTagText);
                     }
                 }
             }
        }
        return results.slice(0, 20);
    }

    function showSuggestions(suggestions, inputElement, tagword) {
        suggestionContainer.innerHTML = '';
        const tagsCount = document.createElement('div');
        tagsCount.textContent = `Found ${suggestions.length} matches for "${tagword}"`;
        tagsCount.style.cssText = `padding: 8px 12px; color: #888; font-size: 0.8em; border-bottom: 1px solid #3a3a3a;`;
        suggestionContainer.appendChild(tagsCount);
        suggestions.forEach(suggestion => suggestionContainer.appendChild(createSuggestionItem(suggestion)));
        const rect = inputElement.getBoundingClientRect();
        suggestionContainer.style.left = `${rect.left + window.scrollX}px`;
        suggestionContainer.style.top = `${rect.bottom + window.scrollY + 5}px`;
        suggestionContainer.style.width = `${rect.width}px`;
        suggestionContainer.style.display = 'block';
        suggestionContainer.classList.remove('slide-out');
        suggestionContainer.classList.add('slide-in');
    }

    function createSuggestionItem(suggestion) {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.style.cssText = `padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #3a3a3a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; justify-content: space-between; align-items: center;`;
        const textContainer = document.createElement('div');
        const suggestionText = document.createElement('span');
        suggestionText.textContent = suggestion.isAlias ? suggestion.source : suggestion.text;
        textContainer.appendChild(suggestionText);
        if (suggestion.isAlias) {
            const notice = document.createElement('span');
            notice.textContent = ` → ${suggestion.text}`;
            notice.style.cssText = `color: #3b82f6; font-size: 0.9em; margin-left: 10px; font-style: italic;`;
            textContainer.appendChild(notice);
        }
        const postCount = document.createElement('span');
        postCount.className = 'ac-post-count';
        postCount.textContent = `${(suggestion.count / 1000).toFixed(1)}k`;
        item.appendChild(textContainer);
        item.appendChild(postCount);
        item.onclick = (e) => { e.stopPropagation(); selectSuggestion(suggestion); };
        item.onmouseover = () => { highlightedIndex = Array.from(suggestionContainer.children).indexOf(item) - 1; updateHighlight(); };
        return item;
    }

    function hideSuggestions() {
        if (suggestionContainer.style.display === 'none') return;
        suggestionContainer.classList.remove('slide-in');
        suggestionContainer.classList.add('slide-out');
        setTimeout(() => { suggestionContainer.style.display = 'none'; highlightedIndex = -1; }, 200);
    }

    function selectSuggestion(suggestion) {
        if (!activeInput || !autocompleteContext) return;

        const isCE = activeInput.isContentEditable;
        const text = isCE ? activeInput.textContent : activeInput.value;
        const { start, end } = autocompleteContext;
        const textToInsert = suggestion.text.replace(/_/g, ' ');
        const originalChunk = text.substring(start, end);

        let newValue, newCursorPos;
        const tagInfo = findTagByCaret(text, start + 1);

        if (tagInfo && tagInfo.tagStart === start && tagInfo.tagEnd === end) {
            const newTag = formatTag(tagInfo.weight, textToInsert);
            newValue = text.substring(0, start) + newTag + text.substring(end);
            newCursorPos = start + newTag.length;
        } else {
            const beforeText = text.substring(0, start);
            const afterText = text.substring(end);
            const leadingWhitespace = (originalChunk.match(/^\s*/) || [''])[0];
            let trailingText = '';
            if (!afterText.trim().startsWith(',')) {
                trailingText = ', ';
            }
            newValue = beforeText + leadingWhitespace + textToInsert + trailingText + afterText;
            newCursorPos = (beforeText + leadingWhitespace + textToInsert + trailingText).length;
        }

        if (isCE) {
            activeInput.textContent = newValue;
            const range = document.createRange(), sel = window.getSelection();
            if (activeInput.childNodes.length > 0) {
                const textNode = activeInput.childNodes[0];
                const finalCursorPos = Math.min(newCursorPos, textNode.textContent.length);
                range.setStart(textNode, finalCursorPos);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
            activeInput.focus();
        } else {
            activeInput.value = newValue;
            activeInput.selectionStart = activeInput.selectionEnd = newCursorPos;
            activeInput.focus();
        }
        activeInput.dispatchEvent(new Event('input', { bubbles: true }));

        hideSuggestions();
        autocompleteContext = null;
    }

    function updateHighlight() {
        const items = suggestionContainer.querySelectorAll('.suggestion-item');
        items.forEach((item, index) => {
            const isHighlighted = index === highlightedIndex;
            item.style.backgroundColor = isHighlighted ? '#4a4a4a' : '';
            if (isHighlighted) item.scrollIntoView({ block: 'nearest' });
        });
    }


  /* ================================================================================= */
  /* ---------------------- WEIGHT WRAPPER CORE ---------------------- */
  /* ================================================================================= */
  const TAG_RE = /(\d+(?:\.\d+)?)(::?):([^:]+?)::/g;

  function isBoundaryChar(ch) { return /[\s\n\r\t.,;:!?()\[\]{}"'`]/.test(ch); }

  function expandToCommaGroup(text, startIndex, endIndex) {
      if (!text) return [startIndex, endIndex];
      let s = startIndex, e = endIndex;
      while (s > 0 && text[s - 1] !== ',') s--;
      while (e < text.length && text[e] !== ',') e++;
      while (s < e && /\s/.test(text[s])) s++;
      while (e > s && /\s/.test(text[e - 1])) e--;
      return [s, e];
  }

  function getEditableElement() {
    const a = document.activeElement;
    if (!a) return null;
    if (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text')) return a;
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
    TAG_RE.lastIndex = 0; let m;
    while ((m = TAG_RE.exec(text)) !== null) {
      if (start >= m.index && end <= TAG_RE.lastIndex) {
        return { tagStart: m.index, tagEnd: TAG_RE.lastIndex, weight: parseFloat(m[1]), inner: m[3] };
      }
    }
    return null;
  }

  function findTagByCaret(text, index) {
    TAG_RE.lastIndex = 0; let m;
    while ((m = TAG_RE.exec(text)) !== null) {
      if (index > m.index && index < TAG_RE.lastIndex) { // Use > and < to be strictly inside
        return { tagStart: m.index, tagEnd: TAG_RE.lastIndex, weight: parseFloat(m[1]), inner: m[3] };
      }
    }
    return null;
  }

  function formatTag(weight, inner) { return `${weight.toFixed(1)}::${inner}::`; }

  function setCaretByOffset(rootEl, offset) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null, false);
    let acc = 0, node = null, nodeOffset = 0;
    while (walker.nextNode()) {
      const t = walker.currentNode, len = t.textContent.length;
      if (acc + len >= offset) { node = t; nodeOffset = offset - acc; break; }
      acc += len;
    }
    if (!node) return;
    const sel = window.getSelection(), range = document.createRange();
    range.setStart(node, nodeOffset); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
  }

  function computeRangeOffsets(rootEl, range) {
    const pre = range.cloneRange(); pre.selectNodeContents(rootEl); pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const pre2 = range.cloneRange(); pre2.selectNodeContents(rootEl); pre2.setEnd(range.endContainer, range.endOffset);
    const end = pre2.toString().length;
    return [Math.min(start, end), Math.max(start, end)];
  }

  function adjustString(text, selStart, selEnd, increase) {
    let start = selStart, end = selEnd;
    if (start === end) {
      [start, end] = expandToWord(text, start);
      if (start === end) {
        const t = findTagByCaret(text, selStart);
        if (!t) return { newText: text, caret: selStart };
        let newWeight = Math.round((t.weight + (increase ? CONFIG.weightStep : -CONFIG.weightStep)) * 10) / 10;
        if (newWeight <= 0 || newWeight === 1.0) {
          const before = text.slice(0, t.tagStart), after = text.slice(t.tagEnd);
          return { newText: before + t.inner + after, caret: (before + t.inner).length };
        }
        const before = text.slice(0, t.tagStart), after = text.slice(t.tagEnd);
        const updated = formatTag(newWeight, t.inner);
        return { newText: before + updated + after, caret: (before + updated).length };
      }
    }

    const tag = findTagByRange(text, start, end);
    if (tag) {
      let newWeight = Math.round((tag.weight + (increase ? CONFIG.weightStep : -CONFIG.weightStep)) * 10) / 10;
      if (newWeight <= 0 || newWeight === 1.0) {
        const before = text.slice(0, tag.tagStart), after = text.slice(tag.tagEnd);
        return { newText: before + tag.inner + after, caret: (before + tag.inner).length };
      }
      const before = text.slice(0, tag.tagStart), after = text.slice(tag.tagEnd);
      const updated = formatTag(newWeight, tag.inner);
      return { newText: before + updated + after, caret: (before + updated).length };
    }

    const word = text.slice(start, end).trim();
    if (!word) return { newText: text, caret: selStart };
    const before = text.slice(0, start), after = text.slice(end);
    const weight = increase ? CONFIG.insertUpWeight : CONFIG.insertDownWeight;
    const inserted = `${weight.toFixed(1)}::${word}::`;
    return { newText: before + inserted + after, caret: (before + inserted).length };
  }

  function adjustInPlain(el, increase) {
    const prevScroll = el.scrollTop;
    const [start, end] = expandToCommaGroup(el.value, el.selectionStart, el.selectionEnd);
    const { newText, caret } = adjustString(el.value, start, end, increase);
    if (newText === el.value) return;
    el.value = newText;
    el.setSelectionRange(caret, caret);
    el.scrollTop = prevScroll;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function adjustInContentEditable(el, increase) {
    const sel = window.getSelection(); if (!sel || sel.rangeCount === 0) return;
    const text = el.innerText || el.textContent || '';
    const [selStart, selEnd] = computeRangeOffsets(el, sel.getRangeAt(0));
    const [start, end] = expandToCommaGroup(text, selStart, selEnd);
    const { newText, caret } = adjustString(text, start, end, increase);
    if (newText === text) return;
    el.innerText = newText;
    setCaretByOffset(el, caret);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function updateWeight(increase) {
    isAdjustingWeight = true; // Set flag to disable suggestions temporarily

    // Immediately hide any active suggestions and reset the context.
    hideSuggestions();
    autocompleteContext = null;

    const el = getEditableElement(); if (!el) return;
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) adjustInPlain(el, increase);
    else if (el.isContentEditable) adjustInContentEditable(el, increase);

    // Reset the flag after a short delay to allow the input event to process.
    setTimeout(() => { isAdjustingWeight = false; }, 50);
  }

  /* ---------------------- HOTKEYS & EVENT LISTENERS ---------------------- */
  let isCapturing = false;
  function matchesHotkey(e, hk) {
    return e.key === hk.key && !!e.ctrlKey === !!hk.ctrl && !!e.altKey === !!hk.alt && !!e.shiftKey === !!hk.shift;
  }

  document.addEventListener('keydown', function (e) {
    // --- MERGED CAPTURE & HOTKEY LOGIC ---
    if (isCapturing) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (!captureTarget) return;

        const isModifierOnly = (k) => ['Shift', 'Control', 'Alt', 'Meta'].includes(k);
        if (isModifierOnly(e.key)) return;

        const combo = { key: normalizeKeyName(e.key), ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey };
        if (captureTarget === 'inc') { CONFIG.increaseHotkey = combo; panel.querySelector('#nwpw-inc').value = comboToString(combo); }
        else if (captureTarget === 'dec') { CONFIG.decreaseHotkey = combo; panel.querySelector('#nwpw-dec').value = comboToString(combo); }
        else { CONFIG.toggleUIHotkey = combo; panel.querySelector('#nwpw-toggle').value = comboToString(combo); }
        saveConfig(CONFIG);
        stopCapture();
        showToast('Shortcut captured');
        return;
    }

    if (suggestionContainer.style.display !== 'none') {
        const keyActions = {
            'ArrowDown': () => { highlightedIndex = (highlightedIndex + 1) % currentSuggestions.length; updateHighlight(); },
            'ArrowUp': () => { highlightedIndex = (highlightedIndex - 1 + currentSuggestions.length) % currentSuggestions.length; updateHighlight(); },
            'Enter': () => { if (highlightedIndex !== -1) selectSuggestion(currentSuggestions[highlightedIndex]); },
            'Tab': () => { if (highlightedIndex !== -1) selectSuggestion(currentSuggestions[highlightedIndex]); },
            'Escape': () => { hideSuggestions(); }
        };
        if (keyActions[e.key]) {
            e.preventDefault();
            e.stopPropagation();
            keyActions[e.key]();
            return;
        }
    }

    if (matchesHotkey(e, CONFIG.toggleUIHotkey)) { e.preventDefault(); toggleUI(); return; }
    if (matchesHotkey(e, CONFIG.increaseHotkey)) { e.preventDefault(); updateWeight(true); return; }
    if (matchesHotkey(e, CONFIG.decreaseHotkey)) { e.preventDefault(); updateWeight(false); return; }
  }, true); // Use CAPTURE phase to handle keys before the site's own listeners

   document.addEventListener('input', (event) => {
        if (isAdjustingWeight) return;
        const target = event.target;
        if (CONFIG.enableTagSuggester && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            activeInput = target;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => runAutocomplete(target), 150);
        }
    });

  document.addEventListener('click', (event) => {
      if (!suggestionContainer.contains(event.target) && event.target !== activeInput) {
          hideSuggestions();
      }
  });
  window.addEventListener('resize', hideSuggestions);


  /* ---------------------- UI (Panel, Buttons, etc.) ---------------------- */
  let panel, gearBtn, overlayBtn, tooltipEl, toastEl, captureNotice, captureTimer = null;

  function injectStyles() {
    if (document.getElementById('nwpw-style')) return;
    const css = `
      :root {
        --bg:#0b0f15; --bg-2:#0e1420; --card:#111827; --border:#1f2a3c;
        --text:#e5e7eb; --muted:#9ca3af; --accent:#4f46e5; --accent-2:#22d3ee;
        --shadow:0 24px 60px rgba(0,0,0,.55), 0 8px 20px rgba(0,0,0,.35);
      }
      @keyframes nwpw-pop { from { opacity:0; transform: translateY(8px) scale(.98); } to { opacity:1; transform: translateY(0) scale(1); } }
      #nwpw-gear, #nwpw-overlay-btn { z-index: 2147483645; }
      #nwpw-gear {
        position: fixed; right: 18px; bottom: 18px; width: auto; height: auto; padding: 8px 14px;
        border-radius: 2px; display: flex; align-items: center; gap: 8px; font-size: 14px;
        background: var(--card); color: var(--text); border: 1px solid var(--border);
        box-shadow: var(--shadow); cursor: pointer; user-select: none;
        transition: transform .15s ease, background .2s ease, border-color .2s ease, box-shadow .2s ease;
      }
      #nwpw-gear:hover {
        transform: translateY(-1px); border-color: var(--accent);
        background: linear-gradient(45deg, var(--accent), var(--accent-2));
        box-shadow: 0 0 15px rgba(79, 70, 229, 0.5);
      }
      #nwpw-overlay-btn {
        position: fixed; right: 18px; top: 18px; padding: 8px 12px; border-radius: 2px;
        background: linear-gradient(180deg,#1e293b,#0f172a); color: var(--text);
        border: 1px solid #334155; box-shadow: var(--shadow); font-size: 13px; cursor: pointer; user-select: none;
        transition: transform .15s ease, filter .2s ease, background .2s ease, border-color .2s ease;
      }
      #nwpw-overlay-btn:hover { transform: translateY(-1px); filter: brightness(1.05); }
      #nwpw-panel {
        position: fixed; min-width: 380px; max-width: 540px;
        background: linear-gradient(180deg, var(--bg), var(--bg-2)); color: var(--text);
        border: 1px solid var(--border); border-radius: 2px; padding: 16px 16px 12px;
        box-shadow: var(--shadow); opacity: 0; transform: translateY(8px) scale(.98);
        transition: opacity .18s ease, transform .18s ease; z-index: 2147483646;
      }
      #nwpw-panel.nwpw-open { opacity:1; transform: translateY(0) scale(1); }
      #nwpw-panel h2{ margin: 0 0 8px; font-size: 16px; letter-spacing:.2px; }
      #nwpw-panel .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 10px 0; align-items: end; }
      #nwpw-panel .row.single { grid-template-columns: 1fr; }
      #nwpw-panel label { font-size: 12px; color: var(--muted); display:block; margin-bottom: 4px; }
      #nwpw-panel input[type="text"], #nwpw-panel input[type="number"] {
        width: 100%; padding: 8px 10px; border-radius: 2px; border: 1px solid var(--border);
        background: #0a1220; color: var(--text); outline: none; transition: border-color .15s ease, box-shadow .15s ease;
      }
      #nwpw-panel input:focus { border-color: var(--accent-2); box-shadow: 0 0 0 3px rgba(34,211,238,.15); }
      #nwpw-panel .btns { display:flex; gap:10px; justify-content: space-between; margin-top: 12px; }
      #nwpw-panel .btn-group { display:flex; gap:10px; }
      #nwpw-panel button {
        padding: 7px 12px; border-radius: 2px; border: 1px solid var(--border);
        background:#0e1626; color:var(--text); cursor:pointer; transition: transform .12s ease, border-color .15s ease, background .15s ease;
      }
      #nwpw-panel button:hover { transform: translateY(-1px); border-color:#334155; background:#101b30; }
      #nwpw-panel button.primary { background: linear-gradient(180deg, #3b82f6, #2563eb); border-color: #1d4ed8; }
      #nwpw-panel button.primary:hover { background: linear-gradient(180deg, #60a5fa, #3b82f6); border-color:#2563eb; }
      #nwpw-panel #nwpw-reset { background: linear-gradient(180deg, #ef4444, #dc2626); border-color: #b91c1c; color: var(--text); }
      #nwpw-panel #nwpw-reset:hover { background: linear-gradient(180deg, #f87171, #ef4444); border-color: #dc2626; }
      #nwpw-panel .header { display:flex; align-items:center; justify-content: space-between; margin-bottom:8px; cursor: move; }
      #nwpw-panel .drag-hint { font-size:11px; color: var(--muted); opacity:.7 }
      #nwpw-close { background: transparent; border: none; font-size: 18px; color:#aab0bb; cursor:pointer; padding:2px 6px; transition: color .15s ease; }
      #nwpw-close:hover { color: #fff; }
      #nwpw-capture-notice, #nwpw-toast { position: fixed; right: 20px; bottom: 72px; min-width: 140px; background: #0f172a; color:#e5e7eb; border:1px solid #1f2a3c; border-radius: 2px; padding: 8px 12px; box-shadow: var(--shadow); z-index: 2147483647; display:none; animation: nwpw-pop .18s ease both; }
      #nwpw-tooltip { position: fixed; pointer-events: none; background: #111827; color:#e5e7eb; border:1px solid #1f2a3c; border-radius: 2px; padding: 6px 8px; font-size: 12px; z-index: 2147483647; display:none; filter: drop-shadow(0 6px 20px rgba(0,0,0,.45)); }
      .inline { display:flex; gap:8px; align-items:center; }
      .hint { color: var(--muted); font-size: 11px; }
      .shortcut-note { font-size: 11px; color: var(--muted); margin-top: 4px; }
      /* Suggester CSS */
      @keyframes slideIn { from { transform: translateX(-10px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-10px); opacity: 0; } }
      .slide-in { animation: slideIn 0.2s ease-out forwards; }
      .slide-out { animation: slideOut 0.2s ease-in forwards; }
      #tag-suggestions-container { position: absolute; z-index: 10000; background-color: #2c2c2c; border: 1px solid #444444; max-height: 200px; overflow-y: auto; box-shadow: 0 6px 12px rgba(0,0,0,0.4); display: none; border-radius: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #f0f0f0; }
      #tag-suggestions-container::-webkit-scrollbar { width: 8px; }
      #tag-suggestions-container::-webkit-scrollbar-track { background: #2c2c2c; }
      #tag-suggestions-container::-webkit-scrollbar-thumb { background-color: #1e40af; border-radius: 4px; }
      #tag-suggestions-container::-webkit-scrollbar-thumb:hover { background-color: #3b82f6; }
      .ac-post-count { color: #888; font-size: 0.9em; margin-left: auto; padding-left: 15px; }

      /* Toggle Switch CSS */
      .nwpw-switch { position: relative; display: inline-block; width: 44px; height: 24px; }
      .nwpw-switch input { opacity: 0; width: 0; height: 0; }
      .nwpw-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #1f2a3c; transition: .4s; border-radius: 24px; }
      .nwpw-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 4px; bottom: 4px; background-color: white; transition: .4s; border-radius: 50%; }
      input:checked + .nwpw-slider { background-color: #4f46e5; }
      input:focus + .nwpw-slider { box-shadow: 0 0 1px #4f46e5; }
      input:checked + .nwpw-slider:before { transform: translateX(20px); }

      /* --- NEW --- First Run Popup & Animation Styles --- */
      @keyframes nwpw-glow {
        0%, 100% { box-shadow: 0 0 5px #22d3ee, 0 0 10px #22d3ee, 0 0 15px #4f46e5; }
        50% { box-shadow: 0 0 15px #4f46e5, 0 0 25px #4f46e5, 0 0 35px #22d3ee; }
      }
      @keyframes nwpw-bounce {
        0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
        40% { transform: translateY(-10px); }
        60% { transform: translateY(-5px); }
      }
      .nwpw-attention {
        animation: nwpw-glow 2.5s infinite, nwpw-bounce 2s infinite;
        border-color: var(--accent-2) !important;
      }
      #nwpw-welcome-popup {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: var(--card); color: var(--text); border: 1px solid var(--border);
        border-radius: 4px; padding: 24px; box-shadow: var(--shadow);
        z-index: 2147483647; text-align: center; animation: nwpw-pop .2s ease-out;
      }
      #nwpw-welcome-popup h3 { margin: 0 0 12px; font-size: 18px; }
      #nwpw-welcome-popup p { margin: 0 0 20px; color: var(--muted); max-width: 350px; }
      #nwpw-welcome-popup .popup-btns button {
        padding: 7px 12px; border-radius: 2px; border: 1px solid var(--border);
        background:#0e1626; color:var(--text); cursor:pointer; transition: transform .12s ease, border-color .15s ease, background .15s ease;
        margin: 0 5px;
      }
      #nwpw-welcome-popup .popup-btns button:hover { transform: translateY(-1px); border-color:#334155; background:#101b30; }
      #nwpw-welcome-popup .popup-btns button.primary { background: linear-gradient(180deg, #3b82f6, #2563eb); border-color: #1d4ed8; }
      #nwpw-welcome-popup .popup-btns button.primary:hover { background: linear-gradient(180deg, #60a5fa, #3b82f6); border-color:#2563eb; }
      #nwpw-github-link {
        display: inline-flex; align-items: center; gap: 8px; margin-top: 16px;
        text-decoration: none; color: var(--muted); transition: color .2s ease;
      }
      #nwpw-github-link:hover { color: var(--text); }
    `;
    const style = document.createElement('style');
    style.id = 'nwpw-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // --- NEW --- Function to show the first-run popup
  function showFirstRunPopup() {
    const popup = document.createElement('div');
    popup.id = 'nwpw-welcome-popup';
    popup.innerHTML = `
      <h3>Welcome!</h3>
      <p>The Prompt Tools script has been installed. You can find the settings button on the bottom right corner of the page.</p>
      <div class="popup-btns">
        <button id="nwpw-popup-ok" class="primary">OK</button>
      </div>
      <a href="https://github.com/DEX-1101/NovelAI-Prompt-Weight-Wrapper" target="_blank" id="nwpw-github-link">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
        </svg>
        <span>View on GitHub</span>
      </a>
    `;
    document.body.appendChild(popup);

    const closePopup = () => {
        gearBtn.classList.remove('nwpw-attention');
        popup.remove();
    };

    popup.querySelector('#nwpw-popup-ok').addEventListener('click', closePopup);

    gearBtn.classList.add('nwpw-attention');
  }


  function ensureTooltip() {
    if (tooltipEl) return;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'nwpw-tooltip';
    tooltipEl.style.zIndex = '2147483647';
    document.body.appendChild(tooltipEl);
  }
  function bringTooltipToFront() {
    if (tooltipEl && tooltipEl.parentNode === document.body) { document.body.removeChild(tooltipEl); document.body.appendChild(tooltipEl); }
  }
  function bindTooltip(el, text) {
    ensureTooltip();
    el.addEventListener('mouseenter', (e) => { bringTooltipToFront(); tooltipEl.textContent = text; tooltipEl.style.display = 'block'; positionTooltip(e); });
    el.addEventListener('mousemove', positionTooltip);
    el.addEventListener('mouseleave', () => { tooltipEl.style.display = 'none'; });
  }
  function positionTooltip(e) {
    const pad = 12;
    tooltipEl.style.left = (e.clientX + pad) + 'px';
    tooltipEl.style.top  = (e.clientY + pad) + 'px';
  }

  function ensureToast() {
    if (toastEl) return;
    toastEl = document.createElement('div'); toastEl.id = 'nwpw-toast';
    toastEl.style.zIndex = '2147483647';
    document.body.appendChild(toastEl);
  }
  function showToast(msg, ms = 1400) {
    ensureToast(); toastEl.textContent = msg; toastEl.style.display = 'block';
    setTimeout(() => { toastEl.style.display = 'none'; }, ms);
  }
  function showCaptureNotice(msg) {
    if (!captureNotice) { captureNotice = document.createElement('div'); captureNotice.id = 'nwpw-capture-notice'; captureNotice.style.zIndex = '2147483647'; document.body.appendChild(captureNotice); }
    bringTooltipToFront();
    captureNotice.textContent = msg; captureNotice.style.display = 'block';
  }
  function hideCaptureNotice() { if (captureNotice) captureNotice.style.display = 'none'; }

  function normalizeKeyName(key) { return key === ' ' ? 'Space' : key; }
  function comboToString(hk) { return `${hk.ctrl ? 'Ctrl+' : ''}${hk.alt ? 'Alt+' : ''}${hk.shift ? 'Shift+' : ''}${hk.key}`; }
  function parseCombo(raw, fallback) {
    const txt = (raw || '').trim(); if (!txt) return fallback;
    const parts = txt.split('+'); const key = parts.pop() || fallback.key;
    const flags = new Set(parts.map(p => p.toLowerCase()));
    return { key, ctrl: flags.has('ctrl'), alt: flags.has('alt'), shift: flags.has('shift') };
  }

  let captureTarget = null;
  function startCapture(target) {
    captureTarget = target; isCapturing = true;
    const which = target === 'inc' ? 'Increase' : target === 'dec' ? 'Decrease' : 'Toggle UI';
    showCaptureNotice(`Press the shortcut for ${which}...`);
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = setTimeout(stopCapture, 6000);
  }
  function stopCapture() {
    isCapturing = false; captureTarget = null; hideCaptureNotice();
    if (captureTimer) { clearTimeout(captureTimer); captureTimer = null; }
  }

  function createGearButton() {
    if (document.getElementById('nwpw-gear')) return;
    gearBtn = document.createElement('button');
    gearBtn.id = 'nwpw-gear';
    gearBtn.setAttribute('aria-label', 'Prompt Weight Wrapper Settings');
    gearBtn.innerHTML = '<span>⚙️</span><span>Settings</span>';
    gearBtn.addEventListener('click', toggleUI, { passive: true });
    document.body.appendChild(gearBtn);
    bindTooltip(gearBtn, 'Open Settings. (Default shortcut: Ctrl+;)');
  }
  function createOverlayButton() {
    if (document.getElementById('nwpw-overlay-btn')) return;
    overlayBtn = document.createElement('button');
    overlayBtn.id = 'nwpw-overlay-btn';
    overlayBtn.type = 'button';
    overlayBtn.textContent = 'Settings';
    overlayBtn.addEventListener('click', toggleUI, { passive: true });
    document.body.appendChild(overlayBtn);
    bindTooltip(overlayBtn, 'Open the Prompt Weight Wrapper settings panel.');
  }

  function createUI() {
    if (document.getElementById('nwpw-panel')) return;
    panel = document.createElement('div'); panel.id = 'nwpw-panel';
    panel.style.display = 'none';
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || '{}');
    panel.style.left = (pos.left ?? 24) + 'px';
    panel.style.top  = (pos.top  ?? 24) + 'px';

    panel.innerHTML = `
      <div class="header" id="nwpw-drag-bar" data-tip="Click and hold to drag this panel.">
        <h2>Prompt Tools Settings</h2>
        <div style="display:flex;gap:10px;align-items:center;">
          <span class="drag-hint">drag me</span>
          <button id="nwpw-close" aria-label="Close" data-tip="Close the settings panel.">✕</button>
        </div>
      </div>

      <div class="row">
        <div>
          <label data-tip="Enable or disable real-time tag suggestions while typing.">Real-time Tag Suggester</label>
          <label class="nwpw-switch">
              <input id="nwpw-suggester-toggle" type="checkbox">
              <span class="nwpw-slider"></span>
          </label>
        </div>
        <div>
          <label data-tip="The amount to increase/decrease weight with each keypress (e.g., 1.1 -> 1.2).">Weight Step</label>
          <input id="nwpw-step" type="number" step="0.1" min="0.1" data-tip="Enter the step value for weight adjustments. Default is 0.1.">
        </div>
      </div>

      <div class="row">
        <div>
          <label data-tip="Set the keyboard shortcut to increase prompt weight.">Increase Shortcut</label>
          <div class="inline"> <input id="nwpw-inc" type="text"><button id="nwpw-cap-inc" type="button">⌨</button> </div>
          <div class="shortcut-note">Example: Ctrl+Alt+ArrowUp</div>
        </div>
        <div>
          <label data-tip="Set the keyboard shortcut to decrease prompt weight.">Decrease Shortcut</label>
          <div class="inline"> <input id="nwpw-dec" type="text"><button id="nwpw-cap-dec" type="button">⌨</button> </div>
          <div class="shortcut-note">Example: Ctrl+Alt+ArrowDown</div>
        </div>
      </div>

      <div class="row single">
        <div>
          <label data-tip="Set the keyboard shortcut to show or hide this panel.">Toggle UI Shortcut</label>
          <div class="inline"> <input id="nwpw-toggle" type="text"><button id="nwpw-cap-toggle" type="button">⌨</button> </div>
        </div>
      </div>

      <div class="row">
        <div>
          <label data-tip="The initial weight applied when you increase weight on an unwrapped prompt.">Insert Up Weight</label>
          <input id="nwpw-upw" type="number" step="0.1" min="0">
        </div>
        <div>
          <label data-tip="The initial weight applied when you decrease weight on an unwrapped prompt.">Insert Down Weight</label>
          <input id="nwpw-dnw" type="number" step="0.1" min="0">
        </div>
      </div>


      <div class="btns">
        <button id="nwpw-reset" data-tip="Reset all settings to their original values.">Reset</button>
        <button id="nwpw-save" class="primary" data-tip="Apply and save your changes.">Save</button>
      </div>
       <div style="margin-top:12px;text-align:right;font-size:12px;color:var(--muted);">
        Made by <a href="https://github.com/DEX-1101/NovelAI-Prompt-Weight-Wrapper" target="_blank" data-tip="give a ⭐ star on github if you find this tool useful :)" style="color:#22d3ee;text-decoration:none;">x1101</a>
      </div>
    `;
    document.body.appendChild(panel);

    const incEl = panel.querySelector('#nwpw-inc'), decEl = panel.querySelector('#nwpw-dec'), togEl = panel.querySelector('#nwpw-toggle');
    const stepEl= panel.querySelector('#nwpw-step'), upwEl = panel.querySelector('#nwpw-upw'), dnwEl = panel.querySelector('#nwpw-dnw');
    const suggesterEl = panel.querySelector('#nwpw-suggester-toggle');

    incEl.value = comboToString(CONFIG.increaseHotkey);
    decEl.value = comboToString(CONFIG.decreaseHotkey);
    togEl.value = comboToString(CONFIG.toggleUIHotkey);
    stepEl.value = CONFIG.weightStep;
    upwEl.value = CONFIG.insertUpWeight;
    dnwEl.value = CONFIG.insertDownWeight;
    suggesterEl.checked = CONFIG.enableTagSuggester;

    panel.querySelector('#nwpw-cap-inc').addEventListener('click', () => startCapture('inc'));
    panel.querySelector('#nwpw-cap-dec').addEventListener('click', () => startCapture('dec'));
    panel.querySelector('#nwpw-cap-toggle').addEventListener('click', () => startCapture('toggle'));

    const dragBar = panel.querySelector('#nwpw-drag-bar');
    let dragging = false, startX=0, startY=0, startLeft=0, startTop=0;
    dragBar.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX; startY = e.clientY;
      startLeft = parseInt(panel.style.left || '24', 10);
      startTop  = parseInt(panel.style.top  || '24', 10);
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (startLeft + e.clientX - startX) + 'px';
      panel.style.top  = (startTop  + e.clientY - startY) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return; dragging = false;
      localStorage.setItem(POS_KEY, JSON.stringify({ left: parseInt(panel.style.left, 10) || 24, top:  parseInt(panel.style.top, 10)  || 24 }));
    });

    panel.querySelector('#nwpw-close').addEventListener('click', closeUI);
    panel.querySelector('#nwpw-reset').addEventListener('click', () => {
      CONFIG = { ...DEFAULTS }; saveConfig(CONFIG);
      panel.remove(); panel = null; createUI(); openUI(); showToast('Defaults restored');
    });
    panel.querySelector('#nwpw-save').addEventListener('click', () => {
      CONFIG.increaseHotkey = parseCombo(incEl.value, DEFAULTS.increaseHotkey);
      CONFIG.decreaseHotkey = parseCombo(decEl.value, DEFAULTS.decreaseHotkey);
      CONFIG.toggleUIHotkey = parseCombo(togEl.value, DEFAULTS.toggleUIHotkey);
      CONFIG.weightStep  = Math.max(0.1, parseFloat(stepEl.value) || DEFAULTS.weightStep);
      CONFIG.insertUpWeight   = Math.max(0, parseFloat(upwEl.value) || DEFAULTS.insertUpWeight);
      CONFIG.insertDownWeight = Math.max(0, parseFloat(dnwEl.value) || DEFAULTS.insertDownWeight);
      CONFIG.enableTagSuggester = suggesterEl.checked;
      saveConfig(CONFIG);
      if (!CONFIG.enableTagSuggester) hideSuggestions();
      showToast('Settings saved');
    });
    panel.querySelectorAll('[data-tip]').forEach(el => bindTooltip(el, el.getAttribute('data-tip')));
  }

  function openUI() {
    if (!panel) createUI();
    panel.style.display = 'block';
    requestAnimationFrame(() => panel.classList.add('nwpw-open'));
  }
  function closeUI() {
    if (!panel) return;
    panel.classList.remove('nwpw-open');
    setTimeout(() => { if (panel) panel.style.display = 'none'; }, 180);
  }
  function toggleUI() {
    if (!panel) { createUI(); openUI(); return; }
    if (panel.style.display === 'none' || !panel.classList.contains('nwpw-open')) openUI(); else closeUI();
  }

  // Init
  function init() {
    injectStyles();
    createGearButton();
    createUI(); // Create but don't show
    fetchTags(); // Fetch tag data for suggester
    document.body.appendChild(suggestionContainer);

    // --- NEW --- Check if it's the first run
    const isFirstRun = localStorage.getItem(FIRST_RUN_KEY) === null;
    if (isFirstRun) {
        setTimeout(() => {
            showFirstRunPopup();
            localStorage.setItem(FIRST_RUN_KEY, 'false');
        }, 1000); // Delay a bit to ensure the page is fully loaded
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();

})();


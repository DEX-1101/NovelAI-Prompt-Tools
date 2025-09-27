// ==UserScript==
// @name         NovelAI Prompt Tools
// @namespace    http://tampermonkey.net/
// @version      4.8.0
// @description  A simple Tampermonkey userscript for NovelAI Image Generator that makes prompting easier with a real-time tag suggestion and prompt saving/restoring functionality.
// @author       x1101
// @match        https://novelai.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
  'use strict';

  /* ---------------------- STORAGE KEYS ---------------------- */
  const LS_KEY = 'nwpw_config_v3';
  const POS_KEY = 'nwpw_panel_pos';
  const FLYOUT_POS_KEY = 'nwpw_flyout_pos';
  const FIRST_RUN_KEY = 'nwpw_first_run_v3.9';
  const LEGACY_KEY_V1 = 'nwpw_config_v1';
  const LEGACY_KEY_V2 = 'nwpw_config_v2';
  // --- Caching for Tag Suggester ---
  const TAG_CACHE_KEY = 'nwpw_tag_data_cache';
  const ALIAS_CACHE_KEY = 'nwpw_alias_data_cache';
  // --- Storage for saved prompts ---
  const PROMPT_STORAGE_KEY = 'nwpw_prompt_preset_v1';


  const DEFAULTS = {
    weightStep: 0.1,
    insertUpWeight: 1.1,
    insertDownWeight: 0.9,
    increaseHotkey: { key: 'ArrowUp',   ctrl: true,  alt: false, shift: false },
    decreaseHotkey: { key: 'ArrowDown', ctrl: true,  alt: false, shift: false },
    toggleUIHotkey: { key: ';',         ctrl: true,  alt: false, shift: false }, // Ctrl+;
    enableTagSuggester: false,
  };

  function migrateLegacy() {
    let raw = localStorage.getItem(LEGACY_KEY_V2);
    if(raw) {
        try { const old = JSON.parse(raw); return { ...DEFAULTS, ...old }; } catch {}
    }
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
  /* ---------------------- PROMPT SAVER CORE (MERGED FEATURE) ----------------------- */
  /* ================================================================================= */

    const PROMPT_SELECTORS = {
        base: '.prompt-input-box-base-prompt .ProseMirror, .prompt-input-box-prompt .ProseMirror',
        uc: '.prompt-input-box-undesired-content .ProseMirror',
        char1: '.prompt-input-box-character-prompts-1 .ProseMirror',
        char2: '.prompt-input-box-character-prompts-2 .ProseMirror',
        char3: '.prompt-input-box-character-prompts-3 .ProseMirror',
    };

    function sleep() {
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }

    function dispatchEvents(element) {
        const inputEvent = new Event('input', { bubbles: true });
        const blurEvent = new Event('blur', { bubbles: true });
        element.dispatchEvent(inputEvent);
        element.dispatchEvent(blurEvent);
    }

    async function savePrompts() {
        console.log('[Prompt Tools] Saving prompts...');
        const promptsToSave = {};
        let fieldsFound = 0;

        for (const key in PROMPT_SELECTORS) {
            const element = document.querySelector(PROMPT_SELECTORS[key]);
            if (element) {
                promptsToSave[key] = element.innerText;
                fieldsFound++;
                console.log(`[Prompt Tools] Found and saved '${key}'.`);
            }
        }

        if (fieldsFound > 0) {
            await GM_setValue(PROMPT_STORAGE_KEY, promptsToSave);
            showToast('Prompts Saved!');
        } else {
            showToast('Error: Could not find any prompt fields.');
        }
    }

    // --- MODIFIED --- This now calls the preview window instead of directly restoring
    async function restorePrompts() {
        console.log('[Prompt Tools] Fetching prompts for preview...');
        const savedPrompts = await GM_getValue(PROMPT_STORAGE_KEY, null);

        if (!savedPrompts || Object.keys(savedPrompts).length === 0) {
            showToast('No saved prompts found.');
            return;
        }

        showRestorePreview(savedPrompts);
    }

    // --- ADDED --- This is the new function that actually applies the prompts to the page
    async function applyPrompts(promptsToRestore) {
        console.log('[Prompt Tools] Restoring prompts...');
        for (const key of Object.keys(PROMPT_SELECTORS)) {
            const element = document.querySelector(PROMPT_SELECTORS[key]);
            if (element) {
                const textToRestore = promptsToRestore[key] || '';
                element.innerText = textToRestore;
                dispatchEvents(element);
                await sleep();
            }
        }
        showToast('Prompts Restored!');
    }


  /* ================================================================================= */
  /* ---------------------- TAG SUGGESTER CORE (PERFORMANCE UPDATE) ------------------ */
  /* ================================================================================= */

    const TAG_DATA_URL = 'https://raw.githubusercontent.com/DEX-1101/NovelAI-Prompt-Tools/refs/heads/main/danbooru2026.csv';
    let allTags = [];
    let aliasMap = new Map();
    let tagTrie = null;
    let autocompleteContext = null;
    let isAdjustingWeight = false;

    class TrieNode {
        constructor() {
            this.children = {};
            this.tags = [];
        }
    }

    function buildTrie(tags, aliases) {
        console.time('[Prompt Tools] Trie build time');
        updateStatus('Building search index...', false, true);
        const root = new TrieNode();
        const tagObjects = new Map(tags.map(t => [t.text, t]));

        for (const tag of tags) {
            let node = root;
            const text = tag.text.toLowerCase();
            for (const char of text) {
                if (!node.children[char]) {
                    node.children[char] = new TrieNode();
                }
                node = node.children[char];
            }
            node.tags.push({ ...tag, source: tag.text });
        }

        for (const [alias, mainTagText] of aliases.entries()) {
            const originalTag = tagObjects.get(mainTagText);
            if (!originalTag) continue;

            let node = root;
            const aliasText = alias.toLowerCase();
            for (const char of aliasText) {
                if (!node.children[char]) {
                    node.children[char] = new TrieNode();
                }
                node = node.children[char];
            }
            node.tags.push({ ...originalTag, source: alias, isAlias: true });
        }
        console.timeEnd('[Prompt Tools] Trie build time');
        return root;
    }

    function parseCsvLine(line) {
        const regex = /(".*?"|[^",]+)(?=\s*,|\s*$)/g;
        const matches = line.match(regex) || [];
        return matches.map(field => field.replace(/^"|"$/g, '').trim());
    }

    async function loadTags() {
        updateStatus('Loading tags...', false, true);
        try {
            const cachedTags = await GM_getValue(TAG_CACHE_KEY);
            const cachedAliasesArray = await GM_getValue(ALIAS_CACHE_KEY);

            if (cachedTags && cachedAliasesArray) {
                allTags = cachedTags;
                aliasMap = new Map(cachedAliasesArray);
                tagTrie = buildTrie(allTags, aliasMap);
                updateStatus(`Loaded ${allTags.length} tags from cache.`);
                return;
            }
        } catch (e) {
            console.error('[Tag Suggester] Failed to parse cached tags. Clearing cache and fetching new data.', e);
            updateStatus('Cache error. Refetching tags...', true);
            await GM_deleteValue(TAG_CACHE_KEY);
            await GM_deleteValue(ALIAS_CACHE_KEY);
        }


        updateStatus('Fetching tags from GitHub...', false, true);
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

                GM_setValue(TAG_CACHE_KEY, allTags);
                GM_setValue(ALIAS_CACHE_KEY, Array.from(aliasMap.entries()));
                tagTrie = buildTrie(allTags, aliasMap);
                updateStatus(`Loaded and cached ${allTags.length} tags.`);
            },
            onerror: function(error) {
                console.error('[Tag Suggester] Failed to fetch tags:', error);
                updateStatus('Failed to fetch tags. Check console.', true);
            }
        });
    }

    const suggestionContainer = document.createElement('div');
    suggestionContainer.id = 'tag-suggestions-container';
    let activeInput = null;
    let currentSuggestions = [];
    let highlightedIndex = -1;
    let debounceTimer;

    function runAutocomplete(textArea) {
        if (!CONFIG.enableTagSuggester || !tagTrie) return;
        const isCE = textArea.isContentEditable;
        const text = isCE ? textArea.textContent : textArea.value;
        const sel = window.getSelection();
        if (isCE && sel.rangeCount === 0) return;

        const [cursorPos, ] = isCE
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
        if (!queryLower) return [];

        let node = tagTrie;
        for (const char of queryLower) {
            if (!node.children[char]) return [];
            node = node.children[char];
        }

        const results = [];
        const seen = new Set();
        const stack = [node];

        while (stack.length > 0 && results.length < 10) {
            const currentNode = stack.pop();

            if (currentNode.tags.length > 0) {
                for (const tag of currentNode.tags) {
                    if (!seen.has(tag.text)) {
                        results.push(tag);
                        seen.add(tag.text);
                    }
                }
            }
            const childrenKeys = Object.keys(currentNode.children).sort((a, b) => b.localeCompare(a));
            for (const key of childrenKeys) {
                stack.push(currentNode.children[key]);
            }
        }
        return results.slice(0, 10);
    }

    function showSuggestions(suggestions, inputElement) {
        suggestionContainer.innerHTML = '';

        const grid = document.createElement('div');
        grid.className = 'suggestions-grid';
        suggestions.forEach(suggestion => grid.appendChild(createSuggestionItem(suggestion)));
        suggestionContainer.appendChild(grid);

        const rect = inputElement.getBoundingClientRect();
        suggestionContainer.style.left = `${rect.left + window.scrollX}px`;
        suggestionContainer.style.top = `${rect.bottom + window.scrollY + 5}px`;
        suggestionContainer.style.width = `max-content`;
        suggestionContainer.style.minWidth = `${rect.width}px`;
        suggestionContainer.style.display = 'block';
        suggestionContainer.classList.remove('slide-out');
        suggestionContainer.classList.add('slide-in');
    }

    function createSuggestionItem(suggestion) {
        const item = document.createElement('div');
        item.className = 'suggestion-item';

        const textContainer = document.createElement('div');
        textContainer.className = 'suggestion-text-container';

        const suggestionText = document.createElement('span');
        suggestionText.textContent = suggestion.source;
        textContainer.appendChild(suggestionText);

        if (suggestion.isAlias) {
            const notice = document.createElement('span');
            notice.textContent = ` → ${suggestion.text}`;
            notice.className = 'suggestion-alias-notice';
            textContainer.appendChild(notice);
        }

        const metaContainer = document.createElement('div');
        metaContainer.className = 'suggestion-meta';

        const countSpan = document.createElement('span');
        countSpan.className = 'suggestion-count';
        countSpan.textContent = `${(suggestion.count / 1000).toFixed(1)}k`;

        metaContainer.appendChild(countSpan);

        item.appendChild(textContainer);
        item.appendChild(metaContainer);

        item.onclick = (e) => { e.stopPropagation(); selectSuggestion(suggestion); };
        item.onmouseover = () => {
            const gridItems = Array.from(suggestionContainer.querySelectorAll('.suggestion-item'));
            highlightedIndex = gridItems.indexOf(item);
            updateHighlight();
        };
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
            if (isHighlighted) {
                item.classList.add('highlighted');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('highlighted');
            }
        });
    }


  /* ================================================================================= */
  /* ---------------------- WEIGHT WRAPPER CORE ---------------------- */
  /* ================================================================================= */
  const TAG_RE = /(\d+(?:\.\d+)?)::(.*?)::/g;

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
        return { tagStart: m.index, tagEnd: TAG_RE.lastIndex, weight: parseFloat(m[1]), inner: m[2] };
      }
    }
    return null;
  }

  function findTagByCaret(text, index) {
    TAG_RE.lastIndex = 0; let m;
    while ((m = TAG_RE.exec(text)) !== null) {
      if (index > m.index && index < TAG_RE.lastIndex) {
        return { tagStart: m.index, tagEnd: TAG_RE.lastIndex, weight: parseFloat(m[1]), inner: m[2] };
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
    isAdjustingWeight = true;
    hideSuggestions();
    autocompleteContext = null;

    const el = getEditableElement(); if (!el) return;
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) adjustInPlain(el, increase);
    else if (el.isContentEditable) adjustInContentEditable(el, increase);

    setTimeout(() => { isAdjustingWeight = false; }, 50);
  }

  /* ---------------------- HOTKEYS & EVENT LISTENERS ---------------------- */
  let isCapturing = false;
  function matchesHotkey(e, hk) {
    return e.key === hk.key && !!e.ctrlKey === !!hk.ctrl && !!e.altKey === !!hk.alt && !!e.shiftKey === !!hk.shift;
  }

  document.addEventListener('keydown', function (e) {
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
        let preventDefault = true;
        switch(e.key) {
            case 'ArrowDown':
                highlightedIndex = highlightedIndex === -1 ? 0 : Math.min(highlightedIndex + 2, currentSuggestions.length - 1);
                break;
            case 'ArrowUp':
                if (highlightedIndex > -1) highlightedIndex = Math.max(highlightedIndex - 2, 0);
                break;
            case 'ArrowRight':
                highlightedIndex = highlightedIndex === -1 ? 0 : Math.min(highlightedIndex + 1, currentSuggestions.length - 1);
                break;
            case 'ArrowLeft':
                if (highlightedIndex > -1) highlightedIndex = Math.max(highlightedIndex - 1, 0);
                break;
            case 'Enter':
            case 'Tab':
                if (highlightedIndex !== -1) selectSuggestion(currentSuggestions[highlightedIndex]);
                break;
            case 'Escape':
                hideSuggestions();
                break;
            default:
                preventDefault = false;
        }

        if (preventDefault) {
            e.preventDefault();
            e.stopPropagation();
            if (!['Enter', 'Tab', 'Escape'].includes(e.key)) {
                updateHighlight();
            }
        }
        return;
    }

    if (matchesHotkey(e, CONFIG.toggleUIHotkey)) { e.preventDefault(); toggleUI(); return; }
    if (matchesHotkey(e, CONFIG.increaseHotkey)) { e.preventDefault(); updateWeight(true); return; }
    if (matchesHotkey(e, CONFIG.decreaseHotkey)) { e.preventDefault(); updateWeight(false); return; }
  }, true);

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
      const flyout = document.getElementById('nwpw-flyout-container');
      const preview = document.getElementById('nwpw-restore-preview');
      if ((flyout && flyout.contains(event.target)) || (preview && preview.contains(event.target))) {
          return;
      }

      if (!suggestionContainer.contains(event.target) && event.target !== activeInput) {
          hideSuggestions();
      }
  });
  window.addEventListener('resize', hideSuggestions);


  /* ---------------------- UI (Panel, Buttons, etc.) ---------------------- */
  let panel, gearBtn, tooltipEl, toastEl, captureNotice, captureTimer = null;

  function updateStatus(message, isError = false, isLoading = false) {
    const statusBar = document.getElementById('nwpw-status-bar');
    if (statusBar) {
        let content = '';
        if (isLoading) {
            content = `<div style="display:flex; align-items:center; gap: 6px;">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="animation: nwpw-spin 1s linear infinite;"><path d="M8 1.5A6.5 6.5 0 1 0 8 14.5A6.5 6.5 0 1 0 8 15Z" stroke="currentColor" stroke-opacity="0.25" stroke-width="3"/><path d="M8 1.5A6.5 6.5 0 1 1 1.5 8" stroke="currentColor" stroke-width="3"/></svg>
                <span>${message}</span>
            </div>`;
        } else {
            content = `<span>${message}</span>`;
        }
        statusBar.innerHTML = content;
        statusBar.style.color = isError ? '#ef4444' : 'var(--muted)';
    }
  }

  function injectStyles() {
    if (document.getElementById('nwpw-style')) return;
    const css = `
      :root {
        --bg:#0b0f15; --bg-2:#0e1420; --card:#111827; --border:#1f2a3c;
        --text:#e5e7eb; --muted:#9ca3af; --accent:#4f46e5; --accent-2:#22d3ee;
        --shadow:0 24px 60px rgba(0,0,0,.55), 0 8px 20px rgba(0,0,0,.35);
      }
      @keyframes nwpw-pop { from { opacity:0; transform: translateY(8px) scale(.98); } to { opacity:1; transform: translateY(0) scale(1); } }
      @keyframes nwpw-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

      /* --- Draggable Flyout SVG Button Styles --- */
      #nwpw-flyout-container {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483645;
        display: flex;
        align-items: center;
        background-color: rgba(28, 28, 30, 0.85);
        border: 1px solid rgba(80, 80, 80, 0.5);
        border-radius: 8px;
        padding: 5px;
        backdrop-filter: blur(8px);
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        transition: all 0.2s ease-in-out;
      }
      #nwpw-main-trigger {
        cursor: grab;
      }
      #nwpw-main-trigger:active {
        cursor: grabbing;
      }
      .nwpw-bar-btn {
        width: 38px;
        height: 38px;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: var(--text);
        border: 1px solid transparent;
        border-radius: 6px;
        cursor: pointer;
        user-select: none;
        transition: background-color .2s ease, border-color .2s ease;
      }
      .nwpw-bar-btn:hover {
        background-color: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.15);
      }
      .nwpw-bar-btn svg {
        width: 22px;
        height: 22px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
        display: block;
      }
      .nwpw-flyout-item {
        width: 0;
        opacity: 0;
        padding: 0;
        margin-right: 0;
        transform: translateX(10px);
        pointer-events: none;
        transition: width 0.2s ease, opacity 0.15s ease, transform 0.2s ease, margin-right 0.2s ease;
      }
      #nwpw-flyout-container:hover .nwpw-flyout-item {
        width: 38px;
        opacity: 1;
        margin-right: 4px;
        transform: translateX(0);
        pointer-events: auto;
      }
      #nwpw-flyout-container:hover .nwpw-flyout-item:nth-child(1) { transition-delay: 0.1s; }
      #nwpw-flyout-container:hover .nwpw-flyout-item:nth-child(2) { transition-delay: 0.05s; }
      #nwpw-flyout-container:hover .nwpw-flyout-item:nth-child(3) { transition-delay: 0s; }

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
      #nwpw-panel .btns { display:flex; gap:10px; justify-content: space-between; align-items: center; margin-top: 12px; }
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
      #nwpw-capture-notice, #nwpw-toast {
        position: fixed; min-width: 140px; background: #0f172a; color:#e5e7eb;
        border:1px solid #1f2a3c; border-radius: 2px; padding: 8px 12px;
        box-shadow: var(--shadow); z-index: 2147483647; display:none;
        animation: nwpw-pop .18s ease both; text-align: center;
      }
      #nwpw-tooltip { position: fixed; pointer-events: none; background: #111827; color:#e5e7eb; border:1px solid #1f2a3c; border-radius: 2px; padding: 6px 8px; font-size: 12px; z-index: 2147483647; display:none; filter: drop-shadow(0 6px 20px rgba(0,0,0,.45)); }
      .inline { display:flex; gap:8px; align-items:center; }
      .hint { color: var(--muted); font-size: 11px; }
      .shortcut-note { font-size: 11px; color: var(--muted); margin-top: 4px; }
      @keyframes slideIn { from { transform: translateX(-10px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-10px); opacity: 0; } }
      .slide-in { animation: slideIn 0.2s ease-out forwards; }
      .slide-out { animation: slideOut 0.2s ease-in forwards; }

      #tag-suggestions-container {
        position: absolute; z-index: 10000;
        background-color: #19202c;
        border: 1px solid #333c4b;
        box-shadow: 0 8px 16px rgba(0,0,0,0.3);
        display: none;
        border-radius: 2px;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        color: #e2e8f0;
        padding: 8px;
        overflow: hidden;
      }
      .suggestions-grid {
        display: grid;
        grid-template-columns: auto auto;
        gap: 6px;
      }
      .suggestion-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background-color: #2a3346;
        border: 1px solid #414a5d;
        padding: 6px 10px;
        border-radius: 2px;
        cursor: pointer;
        transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .suggestion-item:hover, .suggestion-item.highlighted {
        background-color: #3b455c;
        border-color: #555f75;
        color: #fff;
      }
      .suggestion-text-container {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .suggestion-alias-notice {
        color: #38bdf8;
        font-size: 0.9em;
        margin-left: 8px;
        font-style: italic;
      }
      .suggestion-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
        margin-left: 8px;
      }
      .suggestion-count {
        font-size: 0.8em;
        color: #94a3b8;
        transition: color 0.2s ease;
      }
      .suggestion-item:hover .suggestion-count, .suggestion-item.highlighted .suggestion-count {
        color: #e2e8f0;
      }
      .nwpw-switch { position: relative; display: inline-block; width: 44px; height: 24px; }
      .nwpw-switch input { opacity: 0; width: 0; height: 0; }
      .nwpw-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #1f2a3c; transition: .4s; border-radius: 24px; }
      .nwpw-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 4px; bottom: 4px; background-color: white; transition: .4s; border-radius: 50%; }
      input:checked + .nwpw-slider { background-color: #4f46e5; }
      input:focus + .nwpw-slider { box-shadow: 0 0 1px #4f46e5; }
      input:checked + .nwpw-slider:before { transform: translateX(20px); }
      @keyframes nwpw-glow {
        0%, 100% { box-shadow: 0 0 5px #22d3ee, 0 0 10px #22d3ee, 0 0 15px #4f46e5; }
        50% { box-shadow: 0 0 15px #4f46e5, 0 0 25px #4f46e5, 0 0 35px #22d3ee; }
      }
      @keyframes nwpw-bounce {
        0%, 20%, 50%, 80%, 100% { transform: translateY(0); } 40% { transform: translateY(-10px); } 60% { transform: translateY(-5px); }
      }
      .nwpw-attention { animation: nwpw-glow 2.5s infinite, nwpw-bounce 2s infinite; border-color: var(--accent-2) !important; }

      /* --- ADDED --- Styles for the new restore preview window --- */
      @keyframes nwpw-slide-in-right {
        from { opacity: 0; transform: translate(-50%, -50%) translateX(20px); }
        to { opacity: 1; transform: translate(-50%, -50%) translateX(0); }
      }
      @keyframes nwpw-fade-out-left {
        from { opacity: 1; transform: translate(-50%, -50%) translateX(0); }
        to { opacity: 0; transform: translate(-50%, -50%) translateX(-20px); }
      }
      #nwpw-restore-preview {
        position: fixed;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: 400px;
        max-width: 90vw;
        max-height: 80vh;
        background-color: var(--card);
        border: 1px solid var(--border);
        border-radius: 4px;
        box-shadow: var(--shadow);
        z-index: 2147483647;
        color: var(--text);
        display: flex;
        flex-direction: column;
      }
      #nwpw-restore-preview.nwpw-slide-in-right { animation: nwpw-slide-in-right 0.2s ease-out forwards; }
      #nwpw-restore-preview.nwpw-fade-out-left { animation: nwpw-fade-out-left 0.2s ease-in forwards; }
      #nwpw-restore-preview h3 {
        margin: 0; padding: 12px 16px; font-size: 16px;
        border-bottom: 1px solid var(--border);
      }
      #nwpw-restore-preview .preview-content-area {
        padding: 16px;
        overflow-y: auto;
        flex-grow: 1;
      }
      #nwpw-restore-preview .preview-item { margin-bottom: 12px; }
      #nwpw-restore-preview .preview-label {
        font-size: 12px; color: var(--muted); margin-bottom: 4px;
        text-transform: capitalize;
      }
      #nwpw-restore-preview .preview-prompt {
        font-size: 13px; background-color: var(--bg-2); padding: 8px;
        border-radius: 2px; word-break: break-word;
      }
      #nwpw-restore-preview .preview-buttons {
        display: flex; justify-content: flex-end; gap: 10px;
        padding: 12px 16px;
        border-top: 1px solid var(--border);
      }
      /* Use same button styles from settings panel */
      #nwpw-restore-preview .preview-buttons button {
        padding: 7px 12px; border-radius: 2px; border: 1px solid var(--border);
        background:#0e1626; color:var(--text); cursor:pointer; transition: transform .12s ease, border-color .15s ease, background .15s ease;
      }
      #nwpw-restore-preview .preview-buttons button:hover { transform: translateY(-1px); border-color:#334155; background:#101b30; }
      #nwpw-restore-preview .preview-buttons button.primary { background: linear-gradient(180deg, #3b82f6, #2563eb); border-color: #1d4ed8; }
      #nwpw-restore-preview .preview-buttons button.primary:hover { background: linear-gradient(180deg, #60a5fa, #3b82f6); border-color:#2563eb; }
    `;
    const style = document.createElement('style');
    style.id = 'nwpw-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function showFirstRunPopup() {
    // This popup is now superseded by the restore preview, but kept for completeness.
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

  function showToast(msg, ms = 2000) {
    ensureToast();
    toastEl.textContent = msg;

    toastEl.style.visibility = 'hidden';
    toastEl.style.display = 'block';

    const flyout = document.getElementById('nwpw-flyout-container');
    if (flyout) {
        const flyoutRect = flyout.getBoundingClientRect();
        const toastRect = toastEl.getBoundingClientRect();

        const top = flyoutRect.top - toastRect.height - 10;
        const left = flyoutRect.left + (flyoutRect.width / 2) - (toastRect.width / 2);

        toastEl.style.top = `${top}px`;
        toastEl.style.left = `${left}px`;
        toastEl.style.right = 'auto';
        toastEl.style.bottom = 'auto';
    } else {
        toastEl.style.bottom = '72px';
        toastEl.style.right = '20px';
    }

    toastEl.style.visibility = 'visible';

    setTimeout(() => { toastEl.style.display = 'none'; }, ms);
  }

  function showCaptureNotice(msg) {
    if (!captureNotice) { captureNotice = document.createElement('div'); captureNotice.id = 'nwpw-capture-notice'; captureNotice.style.zIndex = '2147483647'; document.body.appendChild(captureNotice); }
    bringTooltipToFront();
    captureNotice.textContent = msg;
    const panelEl = document.getElementById('nwpw-panel');
    if (panelEl && panelEl.style.display !== 'none') {
        const panelRect = panelEl.getBoundingClientRect();
        captureNotice.style.top = `${panelRect.bottom + 10}px`;
        captureNotice.style.left = `${panelRect.left}px`;
        captureNotice.style.right = 'auto';
        captureNotice.style.bottom = 'auto';
    } else {
        captureNotice.style.bottom = '72px';
        captureNotice.style.right = '20px';
    }
    captureNotice.style.display = 'block';
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

    // --- ADDED --- Functions to show and hide the new restore preview window
    function hideRestorePreview() {
        const previewEl = document.getElementById('nwpw-restore-preview');
        if (previewEl) {
            previewEl.classList.remove('nwpw-slide-in-right');
            previewEl.classList.add('nwpw-fade-out-left');
            setTimeout(() => previewEl.remove(), 200);
        }
    }

    function showRestorePreview(savedPrompts) {
        // Remove any existing preview
        hideRestorePreview();

        const previewEl = document.createElement('div');
        previewEl.id = 'nwpw-restore-preview';

        let contentHTML = '';
        const fieldNames = { base: 'Base Prompt', uc: 'Undesired Content', char1: 'Character 1', char2: 'Character 2', char3: 'Character 3' };
        for (const key in savedPrompts) {
            if (savedPrompts[key]) {
                contentHTML += `
                    <div class="preview-item">
                        <div class="preview-label">${fieldNames[key] || key}</div>
                        <div class="preview-prompt">${savedPrompts[key]}</div>
                    </div>`;
            }
        }

        previewEl.innerHTML = `
            <h3>Restore Prompts</h3>
            <div class="preview-content-area">${contentHTML}</div>
            <div class="preview-buttons">
                <button id="nwpw-preview-cancel">Cancel</button>
                <button id="nwpw-preview-ok" class="primary">Restore</button>
            </div>
        `;

        document.body.appendChild(previewEl);

        previewEl.querySelector('#nwpw-preview-ok').addEventListener('click', () => {
            applyPrompts(savedPrompts);
            hideRestorePreview();
        });

        previewEl.querySelector('#nwpw-preview-cancel').addEventListener('click', hideRestorePreview);

        requestAnimationFrame(() => {
             previewEl.classList.add('nwpw-slide-in-right');
        });
    }

    function createMainButtons() {
        if (document.getElementById('nwpw-flyout-container')) return;

        const ICONS = {
            save: `<svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2-2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`,
            restore: `<svg viewBox="0 0 24 24"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg>`,
            settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
            // --- MODIFIED --- Wrapped the path in a group <g> and translated it to the left by 1px to fix optical alignment.
            tools: `<svg viewBox="0 0 24 24"><g transform="translate(-3, 0)"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></g></svg>`
        };

        const container = document.createElement('div');
        container.id = 'nwpw-flyout-container';

        gearBtn = document.createElement('button');
        gearBtn.id = 'nwpw-settings-btn';
        gearBtn.className = 'nwpw-bar-btn nwpw-flyout-item';
        gearBtn.innerHTML = ICONS.settings;
        gearBtn.addEventListener('click', toggleUI);
        bindTooltip(gearBtn, 'Open Settings Panel (Ctrl+;)');

        const restoreBtn = document.createElement('button');
        restoreBtn.id = 'nwpw-restore-prompts';
        restoreBtn.className = 'nwpw-bar-btn nwpw-flyout-item';
        restoreBtn.innerHTML = ICONS.restore;
        restoreBtn.addEventListener('click', restorePrompts);
        bindTooltip(restoreBtn, 'Restore previously saved prompts.');

        const saveBtn = document.createElement('button');
        saveBtn.id = 'nwpw-save-prompts';
        saveBtn.className = 'nwpw-bar-btn nwpw-flyout-item';
        saveBtn.innerHTML = ICONS.save;
        saveBtn.addEventListener('click', savePrompts);
        bindTooltip(saveBtn, 'Save all current prompts.');

        const triggerBtn = document.createElement('button');
        triggerBtn.id = 'nwpw-main-trigger';
        triggerBtn.className = 'nwpw-bar-btn';
        triggerBtn.innerHTML = ICONS.tools;
        bindTooltip(triggerBtn, 'Prompt Tools');

        container.appendChild(gearBtn);
        container.appendChild(restoreBtn);
        container.appendChild(saveBtn);
        container.appendChild(triggerBtn);

        document.body.appendChild(container);

        try {
            const savedPos = JSON.parse(localStorage.getItem(FLYOUT_POS_KEY));
            if (savedPos && typeof savedPos.right === 'number' && typeof savedPos.bottom === 'number') {
                container.style.right = `${savedPos.right}px`;
                container.style.bottom = `${savedPos.bottom}px`;
            }
        } catch {}

        let isDragging = false, startX, startY, startRight, startBottom;
        triggerBtn.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = container.getBoundingClientRect();
            startRight = window.innerWidth - rect.right;
            startBottom = window.innerHeight - rect.bottom;
            container.style.transition = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            container.style.right = `${startRight - dx}px`;
            container.style.bottom = `${startBottom - dy}px`;
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            container.style.transition = '';
            const finalRect = container.getBoundingClientRect();
            const posToSave = {
                right: window.innerWidth - finalRect.right,
                bottom: window.innerHeight - finalRect.bottom
            };
            localStorage.setItem(FLYOUT_POS_KEY, JSON.stringify(posToSave));
        });
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
          <label data-tip="Enable or disable real-time tag suggestions while typing.">Real-time Tag Suggestion</label>
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
        <div class="btn-group">
            <button id="nwpw-reset" data-tip="Reset all settings to their original values.">Reset Settings</button>
            <button id="nwpw-clear-tags" data-tip="Clear the cached tag data and fetch the latest version on the next load.">Clear Tag Cache</button>
        </div>
        <button id="nwpw-save" class="primary" data-tip="Apply and save your changes.">Save</button>
      </div>
      <div class="footer" style="display:flex; justify-content: space-between; align-items: center; margin-top:12px; font-size:12px; color:var(--muted);">
        <span id="nwpw-status-bar" style="font-size: 11px; flex-grow: 1; text-align: left; min-height: 16px;"></span>
        <span>Made by <a href="https://github.com/DEX-1101/NovelAI-Prompt-Weight-Wrapper" target="_blank" data-tip="give a ⭐ star on github if you find this tool useful :)" style="color:#22d3ee;text-decoration:none;">x1101</a></span>
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

    panel.querySelector('#nwpw-clear-tags').addEventListener('click', async () => {
        await GM_deleteValue(TAG_CACHE_KEY);
        await GM_deleteValue(ALIAS_CACHE_KEY);
        tagTrie = null; // Clear the index
        showToast('Tag cache cleared. Reload the page to fetch new tags.');
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
    createMainButtons();
    createUI();
    loadTags();
    document.body.appendChild(suggestionContainer);

    const isFirstRun = localStorage.getItem(FIRST_RUN_KEY) === null;
    if (isFirstRun) {
        setTimeout(() => {
            // The first run popup is no longer necessary as the main UI is self-discoverable.
            localStorage.setItem(FIRST_RUN_KEY, 'false');
        }, 1000);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();

})();

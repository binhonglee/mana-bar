// @ts-nocheck
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	// ============ State ============

	const state = {
		usageData: [],
		config: null,
		activeTab: 'dashboard',
		expandedCards: {},
	};

	// Restore persisted state
	const prev = vscode.getState();
	if (prev) {
		Object.assign(state, prev);
	}

	// ============ Constants ============

	const RING_SIZE = 140;
	const RING_CENTER = 70;
	const RING_RADIUS = 62;
	const RING_STROKE_WIDTH = 8;
	const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
	const SEGMENT_GAP = 3;

	const SERVICE_CONFIG_KEYS = {
		'Claude Code': 'claudeCode',
		'Codex': 'codex',
		'Antigravity': 'antigravity',
		'Gemini': 'gemini',
	};

	// ============ Init ============

	function init() {
		setupTabSwitching();
		setupRefreshButton();
		setupGoSettingsButton();
		setupDisplayModeSelect();
		setupStatusBarTooltipLayoutSelect();
		setupPollingSlider();

		// Render from persisted state if available
		if (state.usageData.length > 0) {
			renderDashboard();
		}
		if (state.config) {
			renderSettings();
		}

		// Tell extension we're ready
		vscode.postMessage({ type: 'ready' });
	}

	// ============ Message Handler ============

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'usageUpdate':
				state.usageData = message.data;
				renderDashboard();
				persistState();
				break;
			case 'configUpdate':
				state.config = message.config;
				renderDashboard();
				renderSettings();
				persistState();
				break;
		}
	});

	function persistState() {
		vscode.setState(state);
	}

	// ============ Tab Switching ============

	function setupTabSwitching() {
		document.querySelectorAll('.tab').forEach((btn) => {
			btn.addEventListener('click', () => {
				const tab = btn.dataset.tab;
				if (!tab) return;

				document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
				document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

				btn.classList.add('active');
				const content = document.getElementById(tab + '-tab');
				if (content) content.classList.add('active');

				state.activeTab = tab;
				persistState();
			});
		});

		// Restore active tab
		if (state.activeTab && state.activeTab !== 'dashboard') {
			const tabBtn = document.querySelector(`.tab[data-tab="${state.activeTab}"]`);
			if (tabBtn) tabBtn.click();
		}
	}

	// ============ Refresh Button ============

	function setupRefreshButton() {
		const btn = document.getElementById('refresh-btn');
		if (!btn) return;
		btn.addEventListener('click', () => {
			btn.classList.add('refreshing');
			vscode.postMessage({ type: 'refresh' });
			setTimeout(() => btn.classList.remove('refreshing'), 1500);
		});
	}

	// ============ Go to Settings Button ============

	function setupGoSettingsButton() {
		const btn = document.getElementById('go-settings-btn');
		if (!btn) return;
		btn.addEventListener('click', () => {
			const settingsTab = document.querySelector('.tab[data-tab="settings"]');
			if (settingsTab) settingsTab.click();
		});
	}

	// ============ Polling Slider ============

	function setupPollingSlider() {
		const slider = document.getElementById('polling-slider');
		const valueDisplay = document.getElementById('polling-value');
		if (!slider || !valueDisplay) return;

		let debounceTimer = null;

		slider.addEventListener('input', () => {
			valueDisplay.textContent = slider.value + 's';
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				vscode.postMessage({
					type: 'setPollingInterval',
					interval: parseInt(slider.value, 10),
				});
			}, 500);
		});
	}

	function setupDisplayModeSelect() {
		const select = document.getElementById('display-mode-select');
		if (!select) return;

		select.addEventListener('change', () => {
			vscode.postMessage({
				type: 'setDisplayMode',
				mode: select.value,
			});
		});
	}

	function setupStatusBarTooltipLayoutSelect() {
		const select = document.getElementById('status-bar-tooltip-layout-select');
		if (!select) return;

		select.addEventListener('change', () => {
			vscode.postMessage({
				type: 'setStatusBarTooltipLayout',
				layout: select.value,
			});
		});
	}

	// ============ Last Updated ============


	// ============ Dashboard Rendering ============

	function getHiddenServices() {
		return state.config?.hiddenServices || [];
	}

	function getDisplayMode() {
		return state.config?.displayMode || 'used';
	}

	function isServiceHidden(serviceName) {
		return getHiddenServices().includes(serviceName);
	}

	function renderDashboard() {
		const container = document.getElementById('cards-container');
		const hiddenContainer = document.getElementById('hidden-cards-container');
		const hiddenSection = document.getElementById('hidden-section');
		const emptyState = document.getElementById('empty-state');
		if (!container || !emptyState) return;

		if (state.usageData.length === 0) {
			container.innerHTML = '';
			if (hiddenContainer) hiddenContainer.innerHTML = '';
			if (hiddenSection) hiddenSection.classList.add('hidden');
			emptyState.classList.remove('hidden');
			return;
		}

		emptyState.classList.add('hidden');

		const hidden = getHiddenServices();
		const visibleData = state.usageData.filter(d => !hidden.includes(d.serviceName));
		const hiddenData = state.usageData.filter(d => hidden.includes(d.serviceName));

		// Render visible cards
		rebuildOrUpdate(container, visibleData);

		// Render hidden cards
		if (hiddenContainer && hiddenSection) {
			if (hiddenData.length > 0) {
				hiddenSection.classList.remove('hidden');
				rebuildOrUpdate(hiddenContainer, hiddenData);
			} else {
				hiddenSection.classList.add('hidden');
				hiddenContainer.innerHTML = '';
			}
		}
	}

	function rebuildOrUpdate(container, dataList) {
		const existingCards = container.querySelectorAll('.service-card');
		const existingNames = new Set(Array.from(existingCards).map(c => c.dataset.service));
		const existingLayouts = new Map(Array.from(existingCards).map(c => [c.dataset.service, c.dataset.layout]));
		const newNames = new Set(dataList.map(d => d.serviceName));

		const needsRebuild =
			existingNames.size !== newNames.size ||
			[...newNames].some(n => !existingNames.has(n)) ||
			dataList.some(data => existingLayouts.get(data.serviceName) !== getCardLayoutKey(data));

		if (needsRebuild) {
			container.innerHTML = '';
			dataList.forEach((data, i) => {
				container.appendChild(createServiceCard(data, i));
			});
		} else {
			dataList.forEach(data => updateServiceCard(data));
		}
	}

	// ============ Card Creation ============

	function getStatusClass(used, limit) {
		if (limit === 0) return 'critical';
		const pct = (used / limit) * 100;
		if (pct >= 100) return 'critical';
		if (pct >= 80) return 'warning';
		return 'ok';
	}

	function getUsedPercent(used, limit) {
		if (limit === 0) return 0;
		const pct = limit === 100 ? used : Math.round((used / limit) * 100);
		return Math.max(0, Math.min(100, pct));
	}

	function getRemainingValue(used, limit) {
		return Math.max(0, limit - used);
	}

	function getDisplayValue(used, limit) {
		return getDisplayMode() === 'remaining' ? getRemainingValue(used, limit) : used;
	}

	function getDisplayPercent(used, limit) {
		if (limit === 0) return 0;
		const usedPct = getUsedPercent(used, limit);
		return getDisplayMode() === 'remaining' ? 100 - usedPct : usedPct;
	}

	function formatUsageValue(used, limit) {
		const value = getDisplayValue(used, limit);
		return limit === 100 ? `${value}` : `${value}/${limit}`;
	}

	function formatUsageDisplay(used, limit) {
		const value = getDisplayValue(used, limit);
		return limit === 100 ? `${value}%` : `${value}/${limit}`;
	}

	function getDisplayVerb() {
		return getDisplayMode() === 'remaining' ? 'left' : 'used';
	}

	function hasQuotaWindows(data) {
		return Array.isArray(data.quotaWindows) && data.quotaWindows.length > 1;
	}

	function hasSegmentedProgress(data) {
		return !hasQuotaWindows(data) && Number.isInteger(data.progressSegments) && data.progressSegments > 1;
	}

	function getCardLayoutKey(data) {
		const metricLayout = hasQuotaWindows(data)
			? `quota:${data.quotaWindows.length}`
			: hasSegmentedProgress(data)
				? `segments:${data.progressSegments}`
				: 'ring';
		const modelsLayout = data.models && data.models.length > 1 ? 'models' : 'nomodels';
		return `${metricLayout}:${modelsLayout}`;
	}

	function getActiveSegmentCount(used, limit, segmentCount) {
		if (!segmentCount || segmentCount <= 0) return 0;
		const pct = getDisplayPercent(used, limit);
		const segmentSize = 100 / segmentCount;
		return Math.max(0, Math.min(segmentCount, Math.round(pct / segmentSize)));
	}

	function renderSegmentedRing(data, displayValue, displayUnit) {
		const segmentCount = data.progressSegments;
		const activeSegments = getActiveSegmentCount(data.totalUsed, data.totalLimit, segmentCount);
		const segmentLength = (CIRCUMFERENCE - (segmentCount * SEGMENT_GAP)) / segmentCount;

		const backgroundSegments = Array.from({ length: segmentCount }, (_, index) => {
			const segmentOffset = -index * (segmentLength + SEGMENT_GAP);
			return `
				<circle class="progress-ring-segment-bg" cx="${RING_CENTER}" cy="${RING_CENTER}" r="${RING_RADIUS}"
					stroke-width="${RING_STROKE_WIDTH}" fill="none"
					stroke-dasharray="${segmentLength} ${CIRCUMFERENCE}"
					stroke-dashoffset="${segmentOffset}"
					transform="rotate(-90 ${RING_CENTER} ${RING_CENTER})" />
			`;
		}).join('');

		const fillSegments = Array.from({ length: segmentCount }, (_, index) => {
			const segmentOffset = -index * (segmentLength + SEGMENT_GAP);
			const activeClass = index < activeSegments ? 'active' : '';
			return `
				<circle class="progress-ring-segment-fill ${activeClass}" cx="${RING_CENTER}" cy="${RING_CENTER}" r="${RING_RADIUS}"
					stroke-width="${RING_STROKE_WIDTH}" fill="none"
					stroke-dasharray="${segmentLength} ${CIRCUMFERENCE}"
					stroke-dashoffset="${segmentOffset}"
					transform="rotate(-90 ${RING_CENTER} ${RING_CENTER})" />
			`;
		}).join('');

		return `
			<div class="progress-ring-container segmented" data-segments="${segmentCount}">
				<svg class="progress-ring" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}">
					${backgroundSegments}
					${fillSegments}
				</svg>
				<div class="progress-text">
					<span class="progress-value">${displayValue}</span>
					<span class="progress-unit">${displayUnit}</span>
				</div>
			</div>
		`;
	}

	function formatResetDisplay(resetTime, prefix = '') {
		const value = formatTimeUntilReset(resetTime);
		if (!prefix || value === '--') {
			return value;
		}
		return `${prefix}${value}`;
	}

	function renderQuotaWindowRows(quotaWindows) {
		if (!quotaWindows || quotaWindows.length === 0) return '';

		return quotaWindows.map(window => {
			const pct = getDisplayPercent(window.used, window.limit);
			const status = getStatusClass(window.used, window.limit);

			return `
				<div class="quota-window status-${status}">
					<div class="quota-window-header">
						<span class="quota-window-label" title="${escapeHtml(window.label)}" aria-label="${escapeHtml(window.label)}">${escapeHtml(window.label)}</span>
						<span class="quota-window-value">${formatUsageDisplay(window.used, window.limit)}</span>
					</div>
					<div class="quota-window-track">
						<div class="quota-window-fill" style="width: ${pct}%"></div>
					</div>
					<div class="quota-window-footer">
						<span class="quota-window-meta">${pct}% ${getDisplayVerb()}</span>
						<span class="quota-window-reset reset-time" data-reset-time="${window.resetTime || ''}" data-reset-prefix="Resets in ">
							${formatResetDisplay(window.resetTime, 'Resets in ')}
						</span>
					</div>
				</div>
			`;
		}).join('');
	}

	function renderMetricSection(data, offset, displayValue, displayUnit) {
		if (hasQuotaWindows(data)) {
			return `
				<div class="quota-windows">
					${renderQuotaWindowRows(data.quotaWindows)}
				</div>
			`;
		}

		if (hasSegmentedProgress(data)) {
			return renderSegmentedRing(data, displayValue, displayUnit);
		}

		return `
			<div class="progress-ring-container">
				<svg class="progress-ring" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}">
					<circle class="progress-ring-bg" cx="${RING_CENTER}" cy="${RING_CENTER}" r="${RING_RADIUS}"
						stroke-width="${RING_STROKE_WIDTH}" fill="none" />
					<circle class="progress-ring-fill" cx="${RING_CENTER}" cy="${RING_CENTER}" r="${RING_RADIUS}"
						stroke-width="${RING_STROKE_WIDTH}" fill="none"
						stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="${CIRCUMFERENCE}"
						transform="rotate(-90 ${RING_CENTER} ${RING_CENTER})" />
				</svg>
				<div class="progress-text">
					<span class="progress-value">${displayValue}</span>
					<span class="progress-unit">${displayUnit}</span>
				</div>
			</div>
		`;
	}

	function renderDetailsSection(data) {
		if (hasQuotaWindows(data)) {
			return '';
		}

		return `
			<div class="card-details">
				<div class="detail-row">
					<span class="detail-label">Resets in</span>
					<span class="detail-value reset-time" data-reset-time="${data.resetTime || ''}" data-reset-prefix="">
						${formatResetDisplay(data.resetTime)}
					</span>
				</div>
			</div>
		`;
	}

	function createServiceCard(data, index) {
		const status = getStatusClass(data.totalUsed, data.totalLimit);
		const pct = getDisplayPercent(data.totalUsed, data.totalLimit);

		const card = document.createElement('div');
		card.className = `service-card status-${status}`;
		card.dataset.service = data.serviceName;
		card.dataset.layout = getCardLayoutKey(data);
		card.style.animationDelay = (index * 0.05) + 's';

		const offset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;

		const displayValue = formatUsageValue(data.totalUsed, data.totalLimit);
		const displayUnit = data.totalLimit === 100 ? '%' : '';

		const hasModels = data.models && data.models.length > 1;
		const isExpanded = state.expandedCards[data.serviceName] || false;

		const isHidden = isServiceHidden(data.serviceName);

		card.innerHTML = `
			<div class="card-header" title="${escapeHtml(data.serviceName)}">
				<span class="service-name" aria-label="${escapeHtml(data.serviceName)}">${escapeHtml(data.serviceName)}</span>
				<button class="card-hide-btn" title="${isHidden ? 'Show' : 'Hide'}" data-service="${escapeHtml(data.serviceName)}">
					${isHidden ? eyeOffIcon() : eyeIcon()}
				</button>
			</div>
			<div class="card-body">
				${renderMetricSection(data, offset, displayValue, displayUnit)}
				${renderDetailsSection(data)}
			</div>
			${hasModels ? `
				<div class="card-models ${isExpanded ? 'expanded' : ''}">
					${renderModelRows(data.models)}
				</div>
				<button class="card-expand-btn ${isExpanded ? 'expanded' : ''}" data-service="${escapeHtml(data.serviceName)}">
					<span class="chevron">&#9660;</span>
					<span class="expand-label">${isExpanded ? 'Hide' : 'Show'} ${data.models.length} model${data.models.length !== 1 ? 's' : ''}</span>
				</button>
			` : ''}
		`;

		// Animate progress ring after DOM insertion
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const ring = card.querySelector('.progress-ring-fill');
				if (ring) {
					ring.style.strokeDashoffset = offset;
				}
			});
		});

		// Setup expand/collapse
		const expandBtn = card.querySelector('.card-expand-btn');
		if (expandBtn) {
			expandBtn.addEventListener('click', () => {
				const models = card.querySelector('.card-models');
				const isNowExpanded = models.classList.toggle('expanded');
				expandBtn.classList.toggle('expanded', isNowExpanded);
				const label = expandBtn.querySelector('.expand-label');
				if (label) {
					label.textContent = `${isNowExpanded ? 'Hide' : 'Show'} ${data.models.length} model${data.models.length !== 1 ? 's' : ''}`;
				}
				state.expandedCards[data.serviceName] = isNowExpanded;
				persistState();
			});
		}

		// Setup hide/show toggle
		const hideBtn = card.querySelector('.card-hide-btn');
		if (hideBtn) {
			hideBtn.addEventListener('click', () => {
				vscode.postMessage({
					type: 'toggleHideService',
					service: data.serviceName,
				});
			});
		}

		return card;
	}

	function renderModelRows(models) {
		if (!models || models.length === 0) return '';
		return models.map(m => `
			<div class="model-row" title="${escapeHtml(m.modelName)}" aria-label="${escapeHtml(m.modelName)}">${escapeHtml(m.modelName)}</div>
		`).join('');
	}

	// ============ Card Update (in-place) ============

	function updateServiceCard(data) {
		const card = document.querySelector(`.service-card[data-service="${CSS.escape(data.serviceName)}"]`);
		if (!card) return;

		const status = getStatusClass(data.totalUsed, data.totalLimit);
		const pct = getDisplayPercent(data.totalUsed, data.totalLimit);
		const offset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;

		// Update status class
		card.className = card.className.replace(/status-\w+/, `status-${status}`);
		card.dataset.layout = getCardLayoutKey(data);

		const quotaWindowsEl = card.querySelector('.quota-windows');
		if (quotaWindowsEl && hasQuotaWindows(data)) {
			quotaWindowsEl.innerHTML = renderQuotaWindowRows(data.quotaWindows);
		} else {
			const ring = card.querySelector('.progress-ring-fill');
			if (ring) {
				ring.style.strokeDashoffset = offset;
			}

			const segmentedRing = card.querySelector('.progress-ring-container.segmented');
			if (segmentedRing && hasSegmentedProgress(data)) {
				segmentedRing.outerHTML = renderSegmentedRing(
					data,
					formatUsageValue(data.totalUsed, data.totalLimit),
					data.totalLimit === 100 ? '%' : ''
				).trim();
			}

			const valueEl = card.querySelector('.progress-value');
			const unitEl = card.querySelector('.progress-unit');
			if (valueEl) {
				valueEl.textContent = formatUsageValue(data.totalUsed, data.totalLimit);
			}
			if (unitEl) {
				unitEl.textContent = data.totalLimit === 100 ? '%' : '';
			}
		}

		// Update reset time
		const resetEl = card.querySelector('.card-details .reset-time');
		if (resetEl) {
			resetEl.dataset.resetTime = data.resetTime || '';
			resetEl.textContent = formatResetDisplay(data.resetTime, resetEl.dataset.resetPrefix || '');
		}

		// Update models if expanded
		const modelsContainer = card.querySelector('.card-models');
		if (modelsContainer && data.models) {
			modelsContainer.innerHTML = renderModelRows(data.models);
		}
	}

	// ============ Settings Rendering ============

	function renderSettings() {
		if (!state.config) return;

		const container = document.getElementById('services-settings');
		if (!container) return;

		const services = [
			{ key: 'antigravity', name: 'Antigravity', desc: 'Google Antigravity usage' },
			{ key: 'claudeCode', name: 'Claude Code', desc: 'Claude Code usage' },
			{ key: 'codex', name: 'Codex', desc: 'OpenAI Codex CLI usage' },
			{ key: 'gemini', name: 'Gemini CLI', desc: 'Google Gemini CLI usage' },
		];

		container.innerHTML = services.map(svc => {
			const enabled = state.config.services[svc.key]?.enabled ?? false;
			return `
				<div class="service-toggle-card">
					<div class="service-toggle-info">
						<div class="service-toggle-name">${svc.name}</div>
						<div class="service-toggle-desc">${svc.desc}</div>
					</div>
					<label class="toggle-switch">
						<input type="checkbox" data-service="${svc.key}" ${enabled ? 'checked' : ''}>
						<span class="toggle-slider"></span>
					</label>
				</div>
			`;
		}).join('');

		// Add toggle event listeners
		container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
			checkbox.addEventListener('change', () => {
				vscode.postMessage({
					type: 'toggleService',
					service: checkbox.dataset.service,
					enabled: checkbox.checked,
				});
			});
		});

		// Update polling slider
		const slider = document.getElementById('polling-slider');
		const valueDisplay = document.getElementById('polling-value');
		if (slider && valueDisplay) {
			slider.value = state.config.pollingInterval;
			valueDisplay.textContent = state.config.pollingInterval + 's';
		}

		const displayModeSelect = document.getElementById('display-mode-select');
		if (displayModeSelect) {
			displayModeSelect.value = state.config.displayMode || 'used';
		}

		const statusBarTooltipLayoutSelect = document.getElementById('status-bar-tooltip-layout-select');
		if (statusBarTooltipLayoutSelect) {
			statusBarTooltipLayoutSelect.value = state.config.statusBarTooltipLayout || 'regular';
		}
	}

	// ============ Helpers ============

	function formatTimeUntilReset(isoString) {
		if (!isoString) return '--';
		const diff = new Date(isoString).getTime() - Date.now();
		if (diff <= 0) return 'Just now';
		const days = Math.floor(diff / 86400000);
		const hours = Math.floor((diff % 86400000) / 3600000);
		const minutes = Math.floor((diff % 3600000) / 60000);
		if (days > 0) return `${days}d ${hours}h`;
		if (hours > 0) return `${hours}h ${minutes}m`;
		return `${minutes}m`;
	}

	function eyeIcon() {
		return '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5C4.136 3.5 1.093 6.617.747 7.012a.5.5 0 000 .676C1.093 8.083 4.136 11.2 8 11.2s6.907-3.117 7.253-3.512a.5.5 0 000-.676C14.907 6.617 11.864 3.5 8 3.5zM8 10.2c-2.672 0-4.97-1.74-5.87-2.7C3.03 6.54 5.328 4.8 8 4.8s4.97 1.74 5.87 2.7C12.97 8.46 10.672 10.2 8 10.2z"/><circle cx="8" cy="7.5" r="2.2"/></svg>';
	}

	function eyeOffIcon() {
		return '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.48 1.48a.5.5 0 01.707 0l12.334 12.334a.5.5 0 01-.707.707L1.48 2.187a.5.5 0 010-.707z"/><path d="M8 3.5c-1.352 0-2.6.39-3.7.998l.87.87A6.547 6.547 0 018 4.8c2.672 0 4.97 1.74 5.87 2.7-.393.42-1.09 1.073-1.971 1.647l.852.852c1.14-.786 1.963-1.674 2.302-2.037a.5.5 0 000-.676C14.907 6.617 11.864 3.5 8 3.5zM2.13 5.353c-1.14.786-1.963 1.674-2.302 2.037a.5.5 0 000 .676C.24 8.46.83 9.12 1.7 9.82l.852-.852C1.69 8.4 1.1 7.82.87 7.5c.393-.42 1.09-1.073 1.971-1.647L2.13 5.353z"/><path d="M5.8 7.5a2.2 2.2 0 013.75-1.55l-3.3 3.3A2.19 2.19 0 015.8 7.5zm1.95 2.05l3.3-3.3c.1.24.15.49.15.75a2.2 2.2 0 01-2.2 2.2c-.26 0-.51-.05-.75-.15z"/></svg>';
	}

	function escapeHtml(str) {
		const div = document.createElement('div');
		div.textContent = str;
		return div.innerHTML;
	}

	// ============ Periodic Timer Updates ============

	setInterval(() => {
		document.querySelectorAll('.reset-time').forEach(el => {
			const resetTime = el.dataset.resetTime;
			el.textContent = formatResetDisplay(resetTime, el.dataset.resetPrefix || '');
		});
	}, 30000);

	// ============ Start ============

	init();
})();

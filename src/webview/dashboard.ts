declare function acquireVsCodeApi(): DashboardApp.VsCodeApi;

namespace DashboardApp {
	type UsageStatus = 'ok' | 'warning' | 'critical';
	type DisplayMode = 'used' | 'remaining';
	type TooltipLayout = 'regular' | 'monospaced';
	type ServiceId = 'claudeCode' | 'codex' | 'vscodeCopilot' | 'antigravity' | 'gemini';

	interface ServiceDescriptor {
		id: ServiceId;
		name: string;
		description: string;
	}

	interface ServiceConfig {
		enabled: boolean;
	}

	interface SerializedModelUsage {
		modelName: string;
		used: number;
		limit: number;
		resetTime?: string;
	}

	interface SerializedUsageMetric {
		used: number;
		limit: number;
		displayText: string;
		displayValueText: string;
		displayUnit: string;
		displayPercent: number;
		displayVerb: string;
		status: UsageStatus;
		statusEmoji: string;
		resetTime?: string;
		resetText?: string;
	}

	interface SerializedQuotaWindowUsage extends SerializedUsageMetric {
		label: string;
	}

	interface SerializedUsageData extends SerializedUsageMetric {
		serviceId: ServiceId;
		serviceName: string;
		totalUsed: number;
		totalLimit: number;
		shortLabel: string;
		summaryText: string;
		progressSegments?: number;
		quotaWindows?: SerializedQuotaWindowUsage[];
		models?: SerializedModelUsage[];
		lastUpdated: string;
	}

	interface DashboardConfig {
		displayMode: DisplayMode;
		statusBarTooltipLayout: TooltipLayout;
		debugLogs: boolean;
		pollingInterval: number;
		services: Record<string, ServiceConfig | undefined>;
		hiddenServices: string[];
		serviceDescriptors: ServiceDescriptor[];
	}

	interface SerializedOutageReport {
		issueNumber: number;
		issueUrl: string;
		title: string;
		service: string;
		model?: string;
		reactionCount: number;
		verified: boolean;
		createdAt: string;
	}

	type HostToWebviewMessage =
		| { type: 'usageUpdate'; data: SerializedUsageData[]; timestamp: string }
		| { type: 'configUpdate'; config: DashboardConfig }
		| { type: 'outageUpdate'; outages: SerializedOutageReport[] };

	type WebviewToHostMessage =
		| { type: 'ready' }
		| { type: 'refresh' }
		| { type: 'toggleService'; service: ServiceId; enabled: boolean }
		| { type: 'setPollingInterval'; interval: number }
		| { type: 'setDisplayMode'; mode: DisplayMode }
		| { type: 'setStatusBarTooltipLayout'; layout: TooltipLayout }
		| { type: 'setDebugLogs'; enabled: boolean }
		| { type: 'toggleHideService'; service: string }
		| { type: 'reportOutage'; serviceId?: ServiceId }
		| { type: 'openOutageUrl'; url: string };

	interface State {
		usageData: SerializedUsageData[];
		outages: SerializedOutageReport[];
		config: DashboardConfig | null;
		activeTab: string;
		expandedCards: Record<string, boolean>;
	}

	export interface VsCodeApi {
		postMessage(message: WebviewToHostMessage): void;
		getState(): Partial<State> | undefined;
		setState(state: State): void;
	}

	const vscode = acquireVsCodeApi();
	const state: State = { usageData: [], outages: [], config: null, activeTab: 'dashboard', expandedCards: {} };
	Object.assign(state, vscode.getState() || {});

	const RING_SIZE = 140;
	const RING_CENTER = 70;
	const RING_RADIUS = 62;
	const RING_STROKE_WIDTH = 8;
	const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
	const SEGMENT_GAP = 3;

	function persistState(): void {
		vscode.setState(state);
	}

	function getHiddenServices(): string[] {
		return state.config?.hiddenServices || [];
	}

	function isServiceHidden(serviceName: string): boolean {
		return getHiddenServices().includes(serviceName);
	}

	function hasQuotaWindows(data: SerializedUsageData): boolean {
		return Boolean(data.quotaWindows && data.quotaWindows.length > 1);
	}

	function hasSegmentedProgress(data: SerializedUsageData): boolean {
		return !hasQuotaWindows(data) && Number.isInteger(data.progressSegments) && (data.progressSegments || 0) > 1;
	}

	function getCardLayoutKey(data: SerializedUsageData): string {
		const metricLayout = hasQuotaWindows(data)
			? `quota:${data.quotaWindows!.length}`
			: hasSegmentedProgress(data)
				? `segments:${data.progressSegments}`
				: 'ring';
		return `${metricLayout}:${data.models && data.models.length > 1 ? 'models' : 'nomodels'}`;
	}

	function getActiveSegmentCount(displayPercent: number, segmentCount = 0): number {
		if (segmentCount <= 0) {
			return 0;
		}
		return Math.max(0, Math.min(segmentCount, Math.round(displayPercent / (100 / segmentCount))));
	}

	function formatTimeUntilReset(isoString?: string): string {
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

	function formatTimeAgo(isoString: string): string {
		const diff = Date.now() - new Date(isoString).getTime();
		const hours = Math.floor(diff / 3600000);
		const minutes = Math.floor((diff % 3600000) / 60000);
		if (hours > 24) return `${Math.floor(hours / 24)}d ago`;
		if (hours > 0) return `${hours}h ${minutes}m ago`;
		if (minutes > 0) return `${minutes}m ago`;
		return 'just now';
	}

	function formatResetDisplay(resetTime?: string, resetText?: string, prefix = ''): string {
		const value = resetTime ? formatTimeUntilReset(resetTime) : (resetText || '--');
		return prefix && value !== '--' ? `${prefix}${value}` : value;
	}

	function escapeHtml(value: string): string {
		const div = document.createElement('div');
		div.textContent = value;
		return div.innerHTML;
	}

	function eyeIcon(): string {
		return '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5C4.136 3.5 1.093 6.617.747 7.012a.5.5 0 000 .676C1.093 8.083 4.136 11.2 8 11.2s6.907-3.117 7.253-3.512a.5.5 0 000-.676C14.907 6.617 11.864 3.5 8 3.5zM8 10.2c-2.672 0-4.97-1.74-5.87-2.7C3.03 6.54 5.328 4.8 8 4.8s4.97 1.74 5.87 2.7C12.97 8.46 10.672 10.2 8 10.2z"/><circle cx="8" cy="7.5" r="2.2"/></svg>';
	}

	function eyeOffIcon(): string {
		return '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.48 1.48a.5.5 0 01.707 0l12.334 12.334a.5.5 0 01-.707.707L1.48 2.187a.5.5 0 010-.707z"/><path d="M8 3.5c-1.352 0-2.6.39-3.7.998l.87.87A6.547 6.547 0 018 4.8c2.672 0 4.97 1.74 5.87 2.7-.393.42-1.09 1.073-1.971 1.647l.852.852c1.14-.786 1.963-1.674 2.302-2.037a.5.5 0 000-.676C14.907 6.617 11.864 3.5 8 3.5zM2.13 5.353c-1.14.786-1.963 1.674-2.302 2.037a.5.5 0 000 .676C.24 8.46.83 9.12 1.7 9.82l.852-.852C1.69 8.4 1.1 7.82.87 7.5c.393-.42 1.09-1.073 1.971-1.647L2.13 5.353z"/><path d="M5.8 7.5a2.2 2.2 0 013.75-1.55l-3.3 3.3A2.19 2.19 0 015.8 7.5zm1.95 2.05l3.3-3.3c.1.24.15.49.15.75a2.2 2.2 0 01-2.2 2.2c-.26 0-.51-.05-.75-.15z"/></svg>';
	}

	function renderQuotaWindowRows(quotaWindows?: SerializedQuotaWindowUsage[]): string {
		if (!quotaWindows?.length) return '';
		return quotaWindows.map((window) => `
			<div class="quota-window status-${window.status}">
				<div class="quota-window-header">
					<span class="quota-window-label" title="${escapeHtml(window.label)}" aria-label="${escapeHtml(window.label)}">${escapeHtml(window.label)}</span>
					<span class="quota-window-value">${window.displayText}</span>
				</div>
				<div class="quota-window-track"><div class="quota-window-fill" style="width: ${window.displayPercent}%"></div></div>
				<div class="quota-window-footer">
					<span class="quota-window-meta">${window.displayPercent}% ${window.displayVerb}</span>
					<span class="quota-window-reset reset-time" data-reset-time="${window.resetTime || ''}" data-reset-prefix="Resets in " data-reset-text="${window.resetText || ''}">${formatResetDisplay(window.resetTime, window.resetText, 'Resets in ')}</span>
				</div>
			</div>
		`).join('');
	}

	function renderMetricSection(data: SerializedUsageData): string {
		if (hasQuotaWindows(data)) {
			return `<div class="quota-windows">${renderQuotaWindowRows(data.quotaWindows)}</div>`;
		}
		if (hasSegmentedProgress(data)) {
			const segmentCount = data.progressSegments || 0;
			const activeSegments = getActiveSegmentCount(data.displayPercent, segmentCount);
			const segmentLength = (CIRCUMFERENCE - (segmentCount * SEGMENT_GAP)) / segmentCount;
			const renderSegment = (index: number, fill: boolean) => {
				const segmentOffset = -index * (segmentLength + SEGMENT_GAP);
				return `
					<circle class="${fill ? `progress-ring-segment-fill ${index < activeSegments ? 'active' : ''}` : 'progress-ring-segment-bg'}" cx="${RING_CENTER}" cy="${RING_CENTER}" r="${RING_RADIUS}"
						stroke-width="${RING_STROKE_WIDTH}" fill="none" stroke-dasharray="${segmentLength} ${CIRCUMFERENCE}" stroke-dashoffset="${segmentOffset}"
						transform="rotate(-90 ${RING_CENTER} ${RING_CENTER})" />
				`;
			};
			return `
				<div class="progress-ring-container segmented" data-segments="${segmentCount}">
					<svg class="progress-ring" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}">
						${Array.from({ length: segmentCount }, (_, index) => renderSegment(index, false)).join('')}
						${Array.from({ length: segmentCount }, (_, index) => renderSegment(index, true)).join('')}
					</svg>
					<div class="progress-text"><span class="progress-value">${data.displayValueText}</span><span class="progress-unit">${data.displayUnit}</span></div>
				</div>
			`;
		}
		return `
			<div class="progress-ring-container">
				<svg class="progress-ring" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}">
					<circle class="progress-ring-bg" cx="${RING_CENTER}" cy="${RING_CENTER}" r="${RING_RADIUS}" stroke-width="${RING_STROKE_WIDTH}" fill="none" />
					<circle class="progress-ring-fill" cx="${RING_CENTER}" cy="${RING_CENTER}" r="${RING_RADIUS}" stroke-width="${RING_STROKE_WIDTH}" fill="none" stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="${CIRCUMFERENCE}" transform="rotate(-90 ${RING_CENTER} ${RING_CENTER})" />
				</svg>
				<div class="progress-text"><span class="progress-value">${data.displayValueText}</span><span class="progress-unit">${data.displayUnit}</span></div>
			</div>
		`;
	}

	function renderModelRows(models?: SerializedModelUsage[]): string {
		return !models?.length ? '' : models.map((model) => `<div class="model-row" title="${escapeHtml(model.modelName)}" aria-label="${escapeHtml(model.modelName)}">${escapeHtml(model.modelName)}</div>`).join('');
	}
	
	function getServiceOutages(serviceId: string): SerializedOutageReport[] {
		return state.outages.filter(o => o.service.toLowerCase() === serviceId.toLowerCase());
	}
	
	function renderOutageIndicator(serviceId: string): string {
		const outages = getServiceOutages(serviceId);
		if (outages.length === 0) return '';
		
		const hasVerified = outages.some(o => o.verified);
		const badgeClass = hasVerified ? 'verified' : 'unverified';
		const icon = hasVerified ? '✅' : '⚠️';
		const countText = outages.length === 1 ? '1 outage' : `${outages.length} outages`;
		
		return `
			<div class="card-outage-indicator ${badgeClass}" data-service="${escapeHtml(serviceId)}" data-count="${outages.length}" data-url="${outages.length === 1 ? escapeHtml(outages[0].issueUrl) : ''}" title="${outages.length === 1 ? 'View issue on GitHub' : 'View all outages in Status tab'}">
				<span class="indicator-icon">${icon}</span>
				<span class="indicator-text">${countText} reported</span>
			</div>
		`;
	}

	function createServiceCard(data: SerializedUsageData, index: number): HTMLElement {
		const card = document.createElement('div');
		const hasModels = Boolean(data.models && data.models.length > 1);
		card.className = `service-card status-${data.status}`;
		card.dataset.service = data.serviceName;
		card.dataset.layout = getCardLayoutKey(data);
		card.style.animationDelay = `${index * 0.05}s`;
		
		const isHidden = isServiceHidden(data.serviceName);
		
		card.innerHTML = `
			<div class="card-header" title="${escapeHtml(data.serviceName)}">
				<span class="service-name" aria-label="${escapeHtml(data.serviceName)}">${escapeHtml(data.serviceName)}</span>
				<div class="card-menu-container">
					<button class="card-menu-btn" title="Menu" aria-label="Menu" aria-haspopup="true" aria-expanded="false">⋮</button>
					<div class="card-dropdown-menu">
						<button class="menu-item hide-btn card-hide-btn" data-service="${escapeHtml(data.serviceName)}">
							<span class="menu-icon">${isHidden ? eyeIcon() : eyeOffIcon()}</span>
							${isHidden ? 'Show on dashboard' : 'Hide from dashboard'}
						</button>
						<button class="menu-item report-btn" data-service="${escapeHtml(data.serviceId)}">
							<span class="menu-icon">⚠️</span>
							Report Outage
						</button>
					</div>
				</div>
			</div>
			<div class="card-body">
				${renderMetricSection(data)}
				${renderOutageIndicator(data.serviceName)}
				${hasQuotaWindows(data) ? '' : `<div class="card-details"><div class="detail-row"><span class="detail-label">Resets in</span><span class="detail-value reset-time" data-reset-time="${data.resetTime || ''}" data-reset-prefix="" data-reset-text="${data.resetText || ''}">${formatResetDisplay(data.resetTime, data.resetText)}</span></div></div>`}
			</div>
			${hasModels ? `<div class="card-models ${state.expandedCards[data.serviceName] ? 'expanded' : ''}">${renderModelRows(data.models)}</div><button class="card-expand-btn ${state.expandedCards[data.serviceName] ? 'expanded' : ''}" data-service="${escapeHtml(data.serviceName)}"><span class="chevron">&#9660;</span><span class="expand-label">${state.expandedCards[data.serviceName] ? 'Hide' : 'Show'} ${data.models!.length} model${data.models!.length !== 1 ? 's' : ''}</span></button>` : ''}
		`;

		const offset = CIRCUMFERENCE - (data.displayPercent / 100) * CIRCUMFERENCE;
		requestAnimationFrame(() => requestAnimationFrame(() => {
			const ring = card.querySelector<SVGCircleElement>('.progress-ring-fill');
			if (ring) ring.style.strokeDashoffset = String(offset);
		}));

		const expandButton = card.querySelector<HTMLButtonElement>('.card-expand-btn');
		if (expandButton && data.models) {
			expandButton.addEventListener('click', () => {
				const models = card.querySelector<HTMLElement>('.card-models');
				if (!models) return;
				const expanded = models.classList.toggle('expanded');
				expandButton.classList.toggle('expanded', expanded);
				const label = expandButton.querySelector<HTMLElement>('.expand-label');
				if (label) {
					const count = data.models?.length ?? 0;
					label.textContent = `${expanded ? 'Hide' : 'Show'} ${count} model${count !== 1 ? 's' : ''}`;
				}
				state.expandedCards[data.serviceName] = expanded;
				persistState();
			});
		}

		// Dropdown menu logic
		const menuBtn = card.querySelector<HTMLButtonElement>('.card-menu-btn');
		const dropdown = card.querySelector<HTMLElement>('.card-dropdown-menu');
		
		if (menuBtn && dropdown) {
			menuBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				const isExpanded = menuBtn.getAttribute('aria-expanded') === 'true';
				
				// Close all other menus first
				document.querySelectorAll('.card-menu-btn').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
				document.querySelectorAll('.card-dropdown-menu').forEach(menu => menu.classList.remove('show'));
				
				if (!isExpanded) {
					menuBtn.setAttribute('aria-expanded', 'true');
					dropdown.classList.add('show');
				}
			});
		}

		card.querySelector<HTMLButtonElement>('.menu-item.hide-btn')?.addEventListener('click', () => {
			vscode.postMessage({ type: 'toggleHideService', service: data.serviceName });
			dropdown?.classList.remove('show');
			menuBtn?.setAttribute('aria-expanded', 'false');
		});
		
		card.querySelector<HTMLButtonElement>('.menu-item.report-btn')?.addEventListener('click', () => {
			vscode.postMessage({ type: 'reportOutage', serviceId: data.serviceId });
			dropdown?.classList.remove('show');
			menuBtn?.setAttribute('aria-expanded', 'false');
		});
		
		const indicator = card.querySelector<HTMLElement>('.card-outage-indicator');
		if (indicator) {
			indicator.addEventListener('click', () => {
				const count = parseInt(indicator.dataset.count || '0', 10);
				if (count === 1 && indicator.dataset.url) {
					vscode.postMessage({ type: 'openOutageUrl', url: indicator.dataset.url });
				} else if (count > 1) {
					switchTab('status');
				}
			});
		}

		return card;
	}

	function updateServiceCard(data: SerializedUsageData): void {
		const card = document.querySelector<HTMLElement>(`.service-card[data-service="${CSS.escape(data.serviceName)}"]`);
		if (!card) return;
		card.className = card.className.replace(/status-\w+/, `status-${data.status}`);
		card.dataset.layout = getCardLayoutKey(data);
		const offset = CIRCUMFERENCE - (data.displayPercent / 100) * CIRCUMFERENCE;
		const quotaWindows = card.querySelector<HTMLElement>('.quota-windows');
		if (quotaWindows && hasQuotaWindows(data)) {
			quotaWindows.innerHTML = renderQuotaWindowRows(data.quotaWindows);
		} else {
			const ring = card.querySelector<SVGCircleElement>('.progress-ring-fill');
			if (ring) ring.style.strokeDashoffset = String(offset);
			const segmented = card.querySelector<HTMLElement>('.progress-ring-container.segmented');
			if (segmented && hasSegmentedProgress(data)) segmented.outerHTML = renderMetricSection(data).trim();
			const value = card.querySelector<HTMLElement>('.progress-value');
			const unit = card.querySelector<HTMLElement>('.progress-unit');
			if (value) value.textContent = data.displayValueText;
			if (unit) unit.textContent = data.displayUnit;
		}
		const reset = card.querySelector<HTMLElement>('.card-details .reset-time');
		if (reset) {
			reset.dataset.resetTime = data.resetTime || '';
			reset.dataset.resetText = data.resetText || '';
			reset.textContent = formatResetDisplay(data.resetTime, data.resetText, reset.dataset.resetPrefix || '');
		}
		
		// Update outage indicator
		let indicatorContainer = card.querySelector<HTMLElement>('.card-outage-indicator');
		const indicatorHtml = renderOutageIndicator(data.serviceName);
		
		if (indicatorContainer && !indicatorHtml) {
			// Remove existing
			indicatorContainer.remove();
		} else if (!indicatorContainer && indicatorHtml) {
			// Add new (insert after metric section)
			const metricSection = card.querySelector<HTMLElement>('.progress-ring-container, .quota-windows');
			if (metricSection) {
				metricSection.insertAdjacentHTML('afterend', indicatorHtml);
				// Wire up event listener for the new element
				indicatorContainer = card.querySelector<HTMLElement>('.card-outage-indicator');
				if (indicatorContainer) {
					indicatorContainer.addEventListener('click', () => {
						const count = parseInt(indicatorContainer!.dataset.count || '0', 10);
						if (count === 1 && indicatorContainer!.dataset.url) {
							vscode.postMessage({ type: 'openOutageUrl', url: indicatorContainer!.dataset.url });
						} else if (count > 1) {
							switchTab('status');
						}
					});
				}
			}
		} else if (indicatorContainer && indicatorHtml) {
			// Update existing (easy way: replace HTML and re-wire)
			indicatorContainer.outerHTML = indicatorHtml;
			const newIndicator = card.querySelector<HTMLElement>('.card-outage-indicator');
			if (newIndicator) {
				newIndicator.addEventListener('click', () => {
					const count = parseInt(newIndicator.dataset.count || '0', 10);
					if (count === 1 && newIndicator.dataset.url) {
						vscode.postMessage({ type: 'openOutageUrl', url: newIndicator.dataset.url });
					} else if (count > 1) {
						switchTab('status');
					}
				});
			}
		}
		
		const models = card.querySelector<HTMLElement>('.card-models');
		if (models && data.models) models.innerHTML = renderModelRows(data.models);
	}

	function rebuildOrUpdate(container: HTMLElement, dataList: SerializedUsageData[]): void {
		const existingCards = Array.from(container.querySelectorAll<HTMLElement>('.service-card'));
		const existingLayouts = new Map(existingCards.map((card) => [card.dataset.service || '', card.dataset.layout || '']));
		const existingNames = new Set(existingCards.map((card) => card.dataset.service || ''));
		const newNames = new Set(dataList.map((data) => data.serviceName));
		const needsRebuild = existingNames.size !== newNames.size
			|| [...newNames].some((name) => !existingNames.has(name))
			|| dataList.some((data) => existingLayouts.get(data.serviceName) !== getCardLayoutKey(data));
		if (needsRebuild) {
			container.innerHTML = '';
			dataList.forEach((data, index) => container.appendChild(createServiceCard(data, index)));
			return;
		}
		dataList.forEach(updateServiceCard);
	}

	function renderDashboard(): void {
		const container = document.getElementById('cards-container');
		const hiddenContainer = document.getElementById('hidden-cards-container');
		const hiddenSection = document.getElementById('hidden-section');
		const emptyState = document.getElementById('empty-state');
		if (!(container instanceof HTMLElement) || !(emptyState instanceof HTMLElement)) return;
		if (state.usageData.length === 0) {
			container.innerHTML = '';
			if (hiddenContainer instanceof HTMLElement) hiddenContainer.innerHTML = '';
			if (hiddenSection instanceof HTMLElement) hiddenSection.classList.add('hidden');
			emptyState.classList.remove('hidden');
			return;
		}
		emptyState.classList.add('hidden');
		const hidden = getHiddenServices();
		const visible = state.usageData.filter((data) => !hidden.includes(data.serviceName));
		const hiddenData = state.usageData.filter((data) => hidden.includes(data.serviceName));
		rebuildOrUpdate(container, visible);
		if (hiddenContainer instanceof HTMLElement && hiddenSection instanceof HTMLElement) {
			if (hiddenData.length > 0) {
				hiddenSection.classList.remove('hidden');
				rebuildOrUpdate(hiddenContainer, hiddenData);
			} else {
				hiddenSection.classList.add('hidden');
				hiddenContainer.innerHTML = '';
			}
		}
	}

	function renderSettings(): void {
		if (!state.config) return;
		const container = document.getElementById('services-settings');
		if (!(container instanceof HTMLElement)) return;
		container.innerHTML = state.config.serviceDescriptors.map((service) => `
			<div class="service-toggle-card">
				<div class="service-toggle-info"><div class="service-toggle-name">${service.name}</div><div class="service-toggle-desc">${service.description}</div></div>
				<label class="toggle-switch"><input type="checkbox" data-service="${service.id}" ${(state.config?.services[service.id]?.enabled ?? false) ? 'checked' : ''}><span class="toggle-slider"></span></label>
			</div>
		`).join('');
		container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
			checkbox.addEventListener('change', () => {
				const service = checkbox.dataset.service as ServiceId | undefined;
				if (service) vscode.postMessage({ type: 'toggleService', service, enabled: checkbox.checked });
			});
		});
		const slider = document.getElementById('polling-slider');
		const value = document.getElementById('polling-value');
		if (slider instanceof HTMLInputElement && value instanceof HTMLElement) {
			slider.value = String(state.config.pollingInterval);
			value.textContent = `${state.config.pollingInterval}s`;
		}
		const displayMode = document.getElementById('display-mode-select');
		if (displayMode instanceof HTMLSelectElement) displayMode.value = state.config.displayMode || 'remaining';
		const tooltipLayout = document.getElementById('status-bar-tooltip-layout-select');
		if (tooltipLayout instanceof HTMLSelectElement) tooltipLayout.value = state.config.statusBarTooltipLayout || 'regular';
		const debugLogs = document.getElementById('debug-logs-toggle');
		if (debugLogs instanceof HTMLInputElement) debugLogs.checked = Boolean(state.config.debugLogs);
	}



	function switchTab(tabId: string): void {
		document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
		const targetTab = document.querySelector(`.tab[data-tab="${tabId}"]`);
		if (targetTab) targetTab.classList.add('active');

		document.querySelectorAll('.tab-content').forEach((tc) => tc.classList.remove('active'));
		const targetContent = document.getElementById(`${tabId}-tab`);
		if (targetContent) targetContent.classList.add('active');

		state.activeTab = tabId;
		persistState();
		if (tabId === 'dashboard') renderDashboard();
		if (tabId === 'settings') renderSettings();
		if (tabId === 'status') renderStatus();
	}

	// Close dropdowns when clicking outside
	document.addEventListener('click', (e) => {
		const target = e.target as HTMLElement;
		if (!target.closest('.card-menu-container')) {
			document.querySelectorAll('.card-menu-btn').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
			document.querySelectorAll('.card-dropdown-menu').forEach(menu => menu.classList.remove('show'));
		}
	});

	function setupTabSwitching(): void {
		document.querySelectorAll('.tab').forEach((tab) => {
			tab.addEventListener('click', () => {
				const target = (tab as HTMLElement).dataset.tab;
				if (target) switchTab(target);
			});
		});
	}

	function renderStatus(): void {
		const container = document.getElementById('outages-list');
		const emptyState = document.getElementById('outages-empty-state');
		if (!(container instanceof HTMLElement) || !(emptyState instanceof HTMLElement)) return;

		if (state.outages.length === 0) {
			container.innerHTML = '';
			emptyState.classList.remove('hidden');
			return;
		}

		emptyState.classList.add('hidden');
		
		// Map outages to HTML
		container.innerHTML = state.outages.map(outage => {
			const badgeHtml = outage.verified 
				? '<span class="status-badge verified" title="Verified by maintainer"><span class="badge-icon">✅</span> Confirmed</span>'
				: '<span class="status-badge unverified" title="Community report (unverified)"><span class="badge-icon">⚠️</span> Unverified</span>';
			
			const modelHtml = outage.model ? `<span class="outage-model">${escapeHtml(outage.model)}</span>` : '<span class="outage-model service-wide">Service-wide</span>';

			return `
				<div class="outage-item">
					<div class="outage-header">
						<div class="outage-title">
							<span class="outage-service">${escapeHtml(outage.service)}</span>
							<span class="outage-separator"></span>
							${modelHtml}
						</div>
						${badgeHtml}
					</div>
					<div class="outage-meta">
						<span class="outage-time" title="${new Date(outage.createdAt).toLocaleString()}">Reported ${formatTimeAgo(outage.createdAt)}</span>
						<span class="outage-reports" title="${outage.reactionCount} user(s) clicked 👍 on this issue">
							<span class="reports-icon">👍</span> ${outage.reactionCount}
						</span>
						<button class="outage-view-btn" data-url="${escapeHtml(outage.issueUrl)}">View on GitHub</button>
					</div>
				</div>
			`;
		}).join('');

		// Add event listeners for "View on GitHub" buttons
		container.querySelectorAll<HTMLButtonElement>('.outage-view-btn').forEach(btn => {
			btn.addEventListener('click', () => {
				const url = btn.dataset.url;
				if (url) {
					vscode.postMessage({ type: 'openOutageUrl', url });
				}
			});
		});
	}

	function renderPersistedState(): void {
		renderDashboard();
		renderSettings();
		renderStatus();
	}

	function init(): void {
		setupTabSwitching();
		document.getElementById('refresh-btn')?.addEventListener('click', () => {
			const button = document.getElementById('refresh-btn');
			if (!(button instanceof HTMLButtonElement)) return;
			button.classList.add('refreshing');
			vscode.postMessage({ type: 'refresh' });
			window.setTimeout(() => button.classList.remove('refreshing'), 1500);
		});
		document.getElementById('go-settings-btn')?.addEventListener('click', () => {
			document.querySelector<HTMLElement>('.tab[data-tab="settings"]')?.click();
		});
		const reportOutageBtn = document.getElementById('report-outage-btn');
		if (reportOutageBtn) {
			reportOutageBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'reportOutage' });
			});
		}
		const slider = document.getElementById('polling-slider');
		const value = document.getElementById('polling-value');
		if (slider instanceof HTMLInputElement && value instanceof HTMLElement) {
			let timer: number | undefined;
			slider.addEventListener('input', () => {
				value.textContent = `${slider.value}s`;
				if (timer !== undefined) window.clearTimeout(timer);
				timer = window.setTimeout(() => {
					vscode.postMessage({ type: 'setPollingInterval', interval: Number.parseInt(slider.value, 10) });
				}, 500);
			});
		}
		const bindSelect = <T extends HTMLSelectElement | HTMLInputElement>(id: string, handler: (element: T) => void) => {
			const element = document.getElementById(id);
			if (element) handler(element as T);
		};
		bindSelect<HTMLSelectElement>('display-mode-select', (element) => {
			element.addEventListener('change', () => vscode.postMessage({ type: 'setDisplayMode', mode: element.value as DisplayMode }));
		});
		bindSelect<HTMLSelectElement>('status-bar-tooltip-layout-select', (element) => {
			element.addEventListener('change', () => vscode.postMessage({ type: 'setStatusBarTooltipLayout', layout: element.value as TooltipLayout }));
		});
		bindSelect<HTMLInputElement>('debug-logs-toggle', (element) => {
			element.addEventListener('change', () => vscode.postMessage({ type: 'setDebugLogs', enabled: element.checked }));
		});

		// Restore any persisted DOM state before activating a tab so reloads keep cards/settings populated.
		renderPersistedState();

		// Initial render based on active tab
		switchTab(state.activeTab || 'dashboard');

		window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'usageUpdate':
					state.usageData = message.data || [];
					renderDashboard();
					break;
				case 'configUpdate':
					state.config = message.config;
					renderSettings();
					renderDashboard();
					break;
				case 'outageUpdate':
					state.outages = message.outages || [];
					renderStatus();
					renderDashboard();
					break;
			}
			persistState();
		});

		window.setInterval(() => {
			let shouldRefresh = false;
			document.querySelectorAll<HTMLElement>('.reset-time').forEach((element) => {
				const resetTime = element.dataset.resetTime;
				if (resetTime) {
					const diff = new Date(resetTime).getTime() - Date.now();
					if (diff <= 0 && diff > -30000) {
						// Just expired (within last 30 seconds) - trigger refresh
						shouldRefresh = true;
					}
				}
				element.textContent = formatResetDisplay(element.dataset.resetTime, element.dataset.resetText, element.dataset.resetPrefix || '');
			});
			if (shouldRefresh) {
				vscode.postMessage({ type: 'refresh' });
			}
		}, 30000);

		vscode.postMessage({ type: 'ready' });
	}

	init();
}

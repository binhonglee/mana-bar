(function () {
	const STORAGE_KEY = 'dashboardHarnessState';
	let persistedState = {};
	const postedMessages = [];

	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY);
		if (raw) {
			persistedState = JSON.parse(raw);
		}
	} catch {
		persistedState = {};
	}

	window.acquireVsCodeApi = function acquireVsCodeApi() {
		return {
			postMessage(message) {
				postedMessages.push(message);
			},
			getState() {
				return persistedState;
			},
			setState(nextState) {
				persistedState = nextState;
				try {
					window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
				} catch {
					// Ignore storage failures in tests
				}
			},
		};
	};

	window.__dashboardHarness = {
		clearPostedMessages() {
			postedMessages.length = 0;
		},
		getPostedMessages() {
			return postedMessages.slice();
		},
		getPersistedState() {
			return persistedState;
		},
		setPersistedState(nextState) {
			persistedState = nextState;
			window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
		},
		clearPersistedState() {
			persistedState = {};
			window.sessionStorage.removeItem(STORAGE_KEY);
		},
		dispatchUsageUpdate(data, timestamp = '2026-03-10T12:00:00.000Z') {
			window.dispatchEvent(new MessageEvent('message', {
				data: { type: 'usageUpdate', data, timestamp },
			}));
		},
		dispatchConfigUpdate(config) {
			window.dispatchEvent(new MessageEvent('message', {
				data: { type: 'configUpdate', config },
			}));
		},
	};
})();

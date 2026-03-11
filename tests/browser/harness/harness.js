(function () {
	let persistedState = {};
	const postedMessages = [];

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

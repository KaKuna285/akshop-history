var operatorData;
const SHOP_DATA = {};
const OP_DATA = {};
// hit-testable regions for every portrait bubble drawn this frame, used to
// power the hover tooltip (populated in testp.beforeDatasetsDraw / afterDatasetDraw)
let iconHitboxes = [];
// hit-testable rectangles for every bar segment drawn this frame (the gap
// between an operator's release/shop appearances), used to power the
// click-to-see-days-between-appearances feature (same populate points as
// iconHitboxes above)
let barHitboxes = [];
const showntypes = {
	Limited: false,
	Normal: true,
	Kernel: false,
};
function createDiagonalPattern(fillcolor) {
	//https://stackoverflow.com/questions/28569667/fill-chart-js-bar-chart-with-diagonal-stripes-or-other-patterns
	// create a 10x10 px canvas for the pattern's base shape
	let shape = document.createElement("canvas");
	shape.width = 10;
	shape.height = 10;
	// get the context for drawing
	let c = shape.getContext("2d");
	c.beginPath();
	c.rect(0, 0, 10, 10);
	c.fillStyle = fillcolor;
	c.fill();
	c.strokeStyle = "#0008";
	c.beginPath();
	c.moveTo(2, 0);
	c.lineTo(10, 8);
	c.stroke();

	c.beginPath();
	c.moveTo(0, 3);
	c.lineTo(7, 10);
	c.stroke();

	c.beginPath();
	c.moveTo(7, 0);
	c.lineTo(10, 3);
	c.stroke();

	c.beginPath();
	c.moveTo(0, 8);
	c.lineTo(2, 10);
	c.stroke();
	// create the pattern from the shape
	return c.createPattern(shape, "repeat");
}
// The shop history and the CN character table download in parallel; the
// EN table is still loaded after CN, since get_char_table() builds the
// shared name -> charId map and its CN_ID_MAP step depends on that order.
Promise.all([
	fetch(extraDataUrl("banner_history.json")).then((res) => {
		if (!res.ok) throw new Error(`banner_history.json: HTTP ${res.status}`);
		return fixedJson(res);
	}),
	get_char_table(false, SERVERS.CN, true),
])
	.then(([js, cnChars]) => {
		SHOP_DATA.EN = js.NA;
		SHOP_DATA.CN = js.CN;
		// (meta.json from health.py is what says whether the update is
		// healthy; banner_history's own timestamp is the fallback until it
		// exists)
		DataHealth.mount(document.getElementById("dataFreshness"), { generatedAt: js.generatedAt });
		operatorData = cnChars;
		OP_DATA.CN = cnChars;
		return get_char_table(false, SERVERS.EN, true);
	})
	.then((js) => {
		OP_DATA.EN = js;
		const SERVER_STARTS = {
			EN: Date.parse("2020-01-16"),
			CN: 1556582400000,
		};
		let selectedServer = "EN";
		// "Dynamic" (the default) keeps the x-axis start pinned to the
		// earliest date among whatever's currently visible, so filtering
		// down to e.g. Normal-pool only doesn't leave a huge stretch of
		// empty axis before the first visible bar. The fixed periods
		// (2y/4y/6y/ALL) are a deliberate "always show exactly this
		// window" choice instead, so they're left alone here.
		let selectedPeriod = "Dynamic";
		function computeDynamicMin(subset) {
			if (!subset.length) return SERVER_STARTS[selectedServer];
			return Math.min(...subset.map((op) => op.first));
		}
		var shownrarities = new Set([5]);
			// "Grey out owned" state for the portrait bubbles -- whether the
			// toggle is on, and which charIds count as owned. Sourced from
			// AccountSync (home page's sync flow) rather than anything
			// store-specific; `hasOwnedData` is kept apart from an empty
			// ownedCharIdSet on purpose (same reasoning as
			// AccountSync.getOwnedOperators() itself) so the toggle can stay
			// hidden entirely for a never-synced visitor instead of just
			// doing nothing visible.
			let greyOutOwned = true;
			const ownedOperatorsList = AccountSync.getOwnedOperators();
			const hasOwnedData = !!ownedOperatorsList;
			const ownedCharIdSet = new Set(ownedOperatorsList || []);
			// Normalization (charId resolution, isKernel flag, date parsing,
			// avatar preload) now lives in util.js's normalizeShopHistory(),
			// shared with the operator page -- SHOP_DATA_BY_CHARID isn't used
			// by this page yet, but keeping it around costs nothing and saves
			// a second pass if a future change here needs charId lookups too.
			const SHOP_DATA_BY_CHARID = {};
			for (const [serv, servdata] of Object.entries(SHOP_DATA)) {
				SHOP_DATA_BY_CHARID[serv] = normalizeShopHistory(
					servdata,
					OP_DATA[serv],
				);
			}
		function filterOperators(servdata) {
			// return a subset of servdata according to active filters
			return Object.values(servdata).filter(
				(x) =>
					shownrarities.has(operatorData[x.charId].rarity) &&
					(showntypes["Limited"] ||
						!operatorData[x.charId]?.isLimited) &&
					(showntypes["Kernel"] || !x.isKernel) &&
					(showntypes["Normal"] ||
						x.isKernel ||
						operatorData[x.charId]?.isLimited),
			);
		}
		function getDatasets(servdata) {
			let subset = filterOperators(servdata);
			var datasets = [
				{
					data: subset,
					xValueType: "dateTime",
					backgroundColor: "#0000",
					parsing: {
						xAxisKey: "first",
						yAxisKey: "op",
					},
					stack: "1",
					categoryPercentage: 0.9,
					barPercentage: 0.6,
				},
			];
			let idx = 0;
			let cont = true;
			while (cont) {
				cont = false;
				for (const [op, data] of Object.entries(servdata)) {
					if (Object.keys(data.shop).length > idx) {
						cont = true;
						data[idx.toString()] =
							data.shop[idx].date -
							(data.shop[idx - 1]?.date || data.first);
					} else data[idx.toString()] = 0;
				}
				if (cont) {
					datasets.push({
						data: subset,
						xValueType: "dateTime",
						backgroundColor: [
							...Array(Object.values(servdata).length).keys(),
						].map((x) =>
							!idx
								? createDiagonalPattern(selectColor(x, 40, 40))
								: selectColor(x, 80),
						),
						parsing: {
							xAxisKey: idx.toString(),
							yAxisKey: "op",
						},
						stack: "1",
						categoryPercentage: 0.9,
						barPercentage: 0.6,
					});
				}
				idx++;
			}
			return datasets;
		}
		Chart.defaults.color = "#dddddd";
		Chart.defaults.font.size = 16;
		const testp = {
			id: "testp",
			beforeDatasetsDraw(chart) {
				// reset hitboxes at the start of every draw pass so stale
				// entries from a previous filter/sort/server change don't linger
				iconHitboxes = [];
				barHitboxes = [];
			},
			beforeDraw(chart) {
				// faint alternating row bands so it's easier to track a row
				// across the full width of the chart, especially on tall lists
				const labels = chart.data.labels;
				if (!labels || !labels.length) return;
				const {
					ctx,
					chartArea: { top, bottom, left, right },
					scales: { y },
				} = chart;
				const bandHeight = (bottom - top) / labels.length;
				ctx.save();
				ctx.fillStyle = "rgba(255,255,255,0.035)";
				for (let idx = 0; idx < labels.length; idx++) {
					if (idx % 2 === 0) continue;
					const centerY = y.getPixelForTick(idx);
					ctx.fillRect(left, centerY - bandHeight / 2, right - left, bandHeight);
				}
				ctx.restore();
			},
			afterDatasetDraw(chart, args, options) {
				const {
					ctx,
					chartArea: { top, bottom, left, right, width, height },
					scales: { x, y },
				} = chart;
				for (
					let i = 0;
					i < chart.data.datasets[args.index].data.length;
					i++
				) {
					//assumue all bars are the same size
					const imgsize = args.meta.data[0].height * 1.8;
					// position is actually the sum of the entire stack

					ctx.save();
					// Dim this portrait bubble when it's an operator already in
					// the synced roster and the "Grey out owned" toggle is on --
					// paired with the ctx.restore() below (and every early
					// "continue" path's own ctx.restore()), so globalAlpha never
					// leaks into the next bubble's drawing.
					if (
						greyOutOwned &&
						ownedCharIdSet.has(
							chart.data.datasets[args.index].data[i].charId,
						)
					) {
						ctx.globalAlpha = 0.35;
					}
					let is_blue =
						chart.data.datasets[args.index].data[i].shop[
							parseInt(args.meta._dataset.parsing.xAxisKey)
						]?.blue;

					// if NaN this is the "first" index
					const shop_idx = parseInt(args.meta._dataset.parsing.xAxisKey);
					let first_apperance = isNaN(shop_idx);
					// if this op appears in the shop later, don't draw the first appearance bubble.
					if (
						first_apperance &&
						Object.keys(
							chart.data.datasets[args.index].data[i].shop,
						).length
					) {
						ctx.restore();
						continue;
					}
					let x_pos = x.getPixelForValue(
						chart.data.datasets[args.index].data[i].shop[
							parseInt(args.meta._dataset.parsing.xAxisKey)
						]?.date,
					);
					if (first_apperance)
						x_pos = x.getPixelForValue(
							chart.data.datasets[args.index].data[i][
								args.meta._dataset.parsing.xAxisKey
							],
						);
					// don't draw if this pt lies to the left of the visible area.
					if (x.getValueForPixel(x_pos) < x.min) {
						ctx.restore();
						continue;
					}
					let y_pos = y.getPixelForValue(
						chart.data.datasets[args.index].data[i][
							args.meta._dataset.parsing.yAxisKey
						],
					);
					if (!x_pos || !y_pos) {
						ctx.restore();
						continue;
					}
					ctx.translate(x_pos, y_pos);
					ctx.beginPath();
					ctx.arc(
						0,
						0,
						Math.min(imgsize / 2, imgsize / 2),
						0,
						Math.PI * 2,
						false,
					);
					ctx.closePath();
					ctx.clip();
					// drawImage() throws on an image that failed to load (and
					// draws nothing for one still loading) -- show a plain
					// disc for those instead.
					const avatar = chart.data.datasets[args.index].data[i].img;
					if (avatar && avatar.complete && avatar.naturalWidth) {
						ctx.drawImage(avatar, -imgsize / 2, -imgsize / 2, imgsize, imgsize);
					} else {
						ctx.fillStyle = "#555";
						ctx.fill();
					}
					ctx.fillStyle = "#0000";
					if (first_apperance) ctx.fillStyle = "#0008";
					if (is_blue) ctx.fillStyle = "#0004";
					ctx.fill();
					ctx.beginPath();
					ctx.arc(
						0,
						0,
						Math.min(imgsize / 2, imgsize / 2),
						0,
						Math.PI * 2,
						false,
					);
					ctx.closePath();
					ctx.strokeStyle = is_blue ? "#4784eb" : "#f8d511";
					ctx.lineWidth = is_blue ? 3 : 2;
					if (!first_apperance) ctx.stroke();
					ctx.restore();

					let rowData = chart.data.datasets[args.index].data[i];

					// record where this bubble landed on screen so mousemove
					// hit-testing can find it and show a date tooltip
					let pointDate = first_apperance
						? rowData[args.meta._dataset.parsing.xAxisKey]
						: rowData.shop[shop_idx]?.date;
					iconHitboxes.push({
						x: x_pos,
						y: y_pos,
						r: imgsize / 2,
						op: rowData.op,
						charId: rowData.charId,
						date: pointDate,
						first: first_apperance,
						blue: is_blue,
						isKernel: rowData.isKernel,
						isLimited: operatorData[rowData.charId]?.isLimited,
						rarity: operatorData[rowData.charId]?.rarity,
						hasShopHistory: rowData.shop.length > 0,
					});

					// record the bar segment (the gap ending at this bubble)
					// so a click can report how many days it spans. Every
					// non-"first" dataset column is one segment: #0 runs
					// from the operator's release to their first shop
					// appearance, #1 from shop appearance 0 to 1, and so on.
					if (!first_apperance) {
						const startDate =
							shop_idx === 0
								? rowData.first
								: rowData.shop[shop_idx - 1]?.date;
						const endDate = rowData.shop[shop_idx]?.date;
						if (
							startDate != null &&
							endDate != null &&
							!isNaN(startDate) &&
							!isNaN(endDate)
						) {
							const startPx = x.getPixelForValue(startDate);
							const barHeight = args.meta.data[i]?.height || imgsize;
							barHitboxes.push({
								x0: Math.min(startPx, x_pos),
								x1: Math.max(startPx, x_pos),
								yTop: y_pos - barHeight / 2,
								yBottom: y_pos + barHeight / 2,
								op: rowData.op,
								charId: rowData.charId,
								segIdx: shop_idx,
								startDate,
								endDate,
							});
						}
					}
				}
			},
		};
		function estimateAxesPaddingForSlantedDates(
			fontSizePx = 12,
			charCount = 8,
			rotationDeg = 45,
		) {
			const radians = (rotationDeg * Math.PI) / 180;
			const labelHeight =
				Math.sin(radians) * charCount * (fontSizePx * 0.65);
			const padding = fontSizePx * 1.25;
			return Math.ceil((labelHeight + padding) * 2);
		}

		function adjustChartHeight(size) {
			let axesPadding = estimateAxesPaddingForSlantedDates(
				parseFloat(getComputedStyle(document.body).fontSize),
			);
			document.getElementById("barChartContainer").style.height =
				((size *
					parseFloat(getComputedStyle(document.body).fontSize) *
					5) /
					5) *
					2 +
				axesPadding +
				"px";
		}

		const sorters = {
			Name: (a, b) => {
				if (a.op > b.op) return 1;
				return -1;
			},
			Release: (a, b) => {
				if (a.first == b.first) {
					if (a.op > b.op) return 1;
					return -1;
				}
				if (a.first > b.first) return 1;
				return -1;
			},
			Shop: (a, b) => {
				let a_last = a.shop[Object.keys(a.shop).length - 1]?.date;
				let b_last = b.shop[Object.keys(b.shop).length - 1]?.date;
				if (a_last == b_last) {
					if (a.first > b.first) return 1;
					return -1;
				}
				if (!a_last) return 1;
				if (!b_last) return -1;
				if (a_last > b_last) return 1;
				return -1;
			},
		};
		var labelSort = sorters.Shop;

		// Restore any settings saved from a previous visit (see
		// js/prefs.js), overwriting the hardcoded defaults set above.
		// `sortName` tracks the restored sort by its KEY, since labelSort
		// itself is just a function reference -- that's what the sort
		// buttons' initial "checked" state (below) compares against.
		selectedServer = getPref("store", "server", selectedServer, (v) =>
			Object.keys(SHOP_DATA).includes(v),
		);
		selectedPeriod = getPref("store", "period", selectedPeriod, (v) =>
			/^(Dynamic|ALL|\d+y)$/.test(v),
		);
		var sortName = getPref("store", "sort", "Shop", (v) =>
			Object.prototype.hasOwnProperty.call(sorters, v),
		);
		labelSort = sorters[sortName];
		shownrarities = new Set(
			getPref("store", "rarities", Array.from(shownrarities), (v) =>
				Array.isArray(v) && v.every((n) => [3, 4, 5].includes(n)),
			),
		);
		Object.assign(
			showntypes,
			getPref("store", "types", showntypes, (v) =>
				v &&
				typeof v === "object" &&
				Object.keys(showntypes).every((k) => typeof v[k] === "boolean"),
			),
		);
		greyOutOwned = getPref("store", "greyOwned", greyOutOwned, (v) => typeof v === "boolean");

		//////////////////////////////////////////////////
		// this is just the contents of redrawCharts()
		let subset = filterOperators(SHOP_DATA[selectedServer]);
		var labels = subset.sort(labelSort).map((x) => x.op);
		var datasets = getDatasets(SHOP_DATA[selectedServer]);
		for (let i = 0; i < datasets.length; i++)
			// remove elements not in labels
			datasets[i].data = subset;
		adjustChartHeight(subset.length);
		// Mirrors the fixed-period math in the Period buttons' own onclick
		// (below) -- needed here too now that a restored (non-"Dynamic")
		// period can be the very first thing rendered, not just something
		// the user clicks into later.
		function computeFixedPeriodMin(period, server) {
			if (period === "ALL") return SERVER_STARTS[server];
			const minDate = new Date();
			minDate.setFullYear(minDate.getFullYear() - parseInt(period));
			return minDate < SERVER_STARTS[server] ? SERVER_STARTS[server] : minDate;
		}
		let initialXMin =
			selectedPeriod === "Dynamic"
				? computeDynamicMin(subset)
				: computeFixedPeriodMin(selectedPeriod, selectedServer);
		//////////////////////////////////////////////////
		let barGraph = new Chart(document.getElementById("opChart"), {
			type: "bar",
			data: {
				labels: labels,
				datasets: datasets,
			},
			plugins: [testp],
			options: {
				events: [],
				animation: {
					duration: 0,
				},
				layout: {
					padding: {
						right: 40,
					},
				},
				indexAxis: "y",
				interaction: {
					// mode: "index",
				},

				plugins: {
					legend: {
						display: false,
					},
					tooltip: {
						enabled: false,
					},
				},
				maintainAspectRatio: false,
				responsive: true,

				scales: {
					x: {
						type: "time",
						time: {
							unit: "month",
						},
						min: initialXMin,
						max: Date.now(),
						grid: {
							// display: false,
							color: "#777",
							// borderColor: "#aaa",
						},
						ticks: { minRotation: 30 },
					},
					x1: {
						position: "top",
						type: "time",
						time: {
							unit: "month",
						},
						min: initialXMin,
						max: Date.now(),
						ticks: { minRotation: 30 },
					},
					y: {
						ticks: {
							padding: 20,
							callback: function (value, index, values) {
								const name = this.getLabelForValue(value);
								const tokens = name.split(" ");
								const theIndex = tokens.findIndex(
									(t) => t.toLowerCase() === "the",
								);
								if (theIndex === -1) return name;
								return (
									tokens.slice(0, theIndex).join(" ") + " Alt"
								);
							},
						},
					},
				},
			},
		});
		// Redraw once every avatar has loaded or definitely failed (see
		// imgReady in util.js) -- one missing icon no longer stops this.
		Promise.all(Object.values(SHOP_DATA[selectedServer]).map((x) => x.imgReady)).then(() => {
			barGraph.update();
		});

		// --- hover tooltip for the portrait bubbles ---------------------------
		// Chart.js's own tooltip/hover system is disabled for this chart
		// (the bars are invisible; only the plugin-drawn bubbles are visible),
		// so we hit-test the recorded bubble positions ourselves.
		const opCanvas = document.getElementById("opChart");
		const iconTooltipEl = document.getElementById("chartjs-tooltip");
		function findHoveredIcon(mx, my) {
			let best = null;
			let bestDist = Infinity;
			for (const hb of iconHitboxes) {
				const dx = mx - hb.x;
				const dy = my - hb.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				if (dist <= hb.r && dist < bestDist) {
					bestDist = dist;
					best = hb;
				}
			}
			return best;
		}
		function findHoveredBarSegment(mx, my) {
			// last match wins (rows drawn later are on top, same convention
			// as findHoveredIcon effectively gets via closest-distance)
			let best = null;
			for (const seg of barHitboxes) {
				if (mx >= seg.x0 && mx <= seg.x1 && my >= seg.yTop && my <= seg.yBottom) {
					best = seg;
				}
			}
			return best;
		}
		// Standard-pool debut prediction now lives in util.js, shared with
		// the operator page (getStandardPoolPipeline()/predictShopDebut()).
		function showIconTooltip(hb, pageX, pageY) {
			const dateStr = isNaN(hb.date)
				? "Unknown date"
				: new Date(hb.date).toLocaleDateString(undefined, {
						year: "numeric",
						month: "short",
						day: "numeric",
					});
			let kind;
			if (hb.first) {
				// A Limited-pool op who hasn't hit the shop yet: label it
				// "Limited" rather than the generic "not yet in shop" line,
				// since Limited ops aren't expected to hit the shop on any
				// predictable schedule the way Standard-pool ops are. A 4*
				// op never gets added to the shop at all, so "not yet in
				// shop" doesn't really apply -- just say "First released".
				// (rarity is 0-indexed here: TIER_4 remaps to 3, not 4 --
				// see RARITY_MAP in util.js.)
				if (hb.isLimited) {
					kind = "Limited";
				} else if (hb.rarity === 3) {
					kind = "First released";
				} else {
					kind = "First released (not yet in shop)";
				}
			} else if (hb.blue) {
				kind = "Shop rotation · Kernel pool";
			} else if (hb.isLimited) {
				kind = "Shop rotation · Limited pool";
			} else {
				kind = "Shop rotation · Standard pool";
			}

			// Standard-pool 5*/6* operators who have never appeared in the
			// shop yet: predict a debut date from a fixed weekly cadence,
			// shared with the operator page via util.js's predictShopDebut().
			// (4* operators never get added to the shop, so no prediction.)
			let predictionHtml = "";
			if (hb.first) {
				const prediction = predictShopDebut(
					hb,
					SHOP_DATA[selectedServer],
					operatorData,
				);
				if (
					prediction == null &&
					!hb.hasShopHistory &&
					!hb.isKernel &&
					!hb.isLimited &&
					SHOP_DEBUT_CADENCE_WEEKS[hb.rarity] != null
				) {
					// No same-rarity Standard-pool operator has ever been
					// shopped yet on this server, so there's nothing to
					// anchor a prediction to.
					predictionHtml =
						'<span style="opacity:0.7">No same-rarity Standard-pool shop debut yet to predict from</span>';
				} else if (prediction != null) {
					const predictedStr = new Date(
						prediction.predictedDate,
					).toLocaleDateString(undefined, {
						year: "numeric",
						month: "short",
						day: "numeric",
					});
					const anchorStr = new Date(
						prediction.anchorDate,
					).toLocaleDateString(undefined, {
						year: "numeric",
						month: "short",
						day: "numeric",
					});
					predictionHtml =
						`<span style="opacity:0.8">Predicted shop debut: ~${predictedStr}</span>` +
						`<span style="opacity:0.55;font-size:0.82em;">#${prediction.position} in line · anchored to ${escapeHtml(prediction.anchorOp)}'s shop debut (${anchorStr})</span>`;
				}
			}

			const kindHtml = kind ? `<span>${kind}</span>` : "";

			// Only actually clickable once the tooltip is pinned (see the
			// ".pinned" rule in css/shoplist-extra.css, which is what lifts
			// the box's usual pointer-events:none) -- same "click to lock it
			// in place, then interact with it" flow the pin feature itself
			// already trained people on, rather than a link that vanishes
			// out from under the cursor on the next mousemove.
			const operatorPageLink = hb.charId
				? `<a href="/operator/?id=${encodeURIComponent(hb.charId)}" class="tooltipOperatorPageLink">View operator page →</a>`
				: "";

			iconTooltipEl.className = "";
			iconTooltipEl.classList.add("xcenter", "ybottom");
			iconTooltipEl.classList.toggle("pinned", !!(pinnedIcon && pinnedIcon.hb === hb));
			iconTooltipEl.innerHTML =
				'<div style="display:flex;align-items:center;gap:8px;">' +
				`<img src="${uri_avatar(hb.charId)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">` +
				'<div style="display:flex;flex-direction:column;line-height:1.35;white-space:nowrap;">' +
				`<span><b>${escapeHtml(hb.op)}</b></span>` +
				kindHtml +
				`<span style="opacity:0.8">${dateStr}</span>` +
				predictionHtml +
				operatorPageLink +
				"</div></div>";
			iconTooltipEl.style.left = pageX + "px";
			iconTooltipEl.style.top = pageY + "px";
			iconTooltipEl.style.transform = "translate(-50%, calc(-100% - 14px))";
		}
		// Operator names come from the wikis (via the daily scrape), so
		// they're escaped before going into the tooltips' HTML.
		function escapeHtml(text) {
			return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
		}
		function hideIconTooltip() {
			iconTooltipEl.classList.add("hidden");
			iconTooltipEl.classList.remove("pinned");
			opCanvas.style.cursor = "default";
		}
		function daysBetween(startDate, endDate) {
			return Math.round((endDate - startDate) / (24 * 60 * 60 * 1000));
		}
		function showBarGapTooltip(seg, pageX, pageY) {
			const fmt = (d) =>
				new Date(d).toLocaleDateString(undefined, {
					year: "numeric",
					month: "short",
					day: "numeric",
				});
			const days = daysBetween(seg.startDate, seg.endDate);
			const label =
				seg.segIdx === 0
					? "First release → first shop appearance"
					: `Shop appearance #${seg.segIdx} → #${seg.segIdx + 1}`;
			iconTooltipEl.className = "";
			iconTooltipEl.classList.add("xcenter", "ybottom");
			iconTooltipEl.innerHTML =
				'<div style="display:flex;flex-direction:column;line-height:1.35;white-space:nowrap;">' +
				`<span><b>${escapeHtml(seg.op)}</b></span>` +
				`<span>${label}</span>` +
				`<span style="opacity:0.8">${fmt(seg.startDate)} → ${fmt(seg.endDate)}</span>` +
				`<span style="opacity:0.8"><b>${days}</b> day${days === 1 ? "" : "s"}</span>` +
				"</div>";
			iconTooltipEl.style.left = pageX + "px";
			iconTooltipEl.style.top = pageY + "px";
			iconTooltipEl.style.transform = "translate(-50%, calc(-100% - 14px))";
		}
		// A bar segment ("line") or portrait bubble the user clicked on, kept
		// showing in place until they click it again, click elsewhere,
		// change a filter/sort/server/period, or click the other kind of
		// pinnable element (only one tooltip is ever shown at a time, so
		// pinning one clears the other).
		let pinnedGap = null;
		let pinnedIcon = null;
		opCanvas.addEventListener("mousemove", (e) => {
			const hb = findHoveredIcon(e.offsetX, e.offsetY);
			const overSegment = findHoveredBarSegment(e.offsetX, e.offsetY);
			if (hb) {
				showIconTooltip(hb, e.pageX, e.pageY);
				opCanvas.style.cursor = "pointer";
			} else if (pinnedIcon) {
				// keep showing the pinned portrait's info while the mouse
				// isn't over a portrait bubble, same idea as a pinned gap
				showIconTooltip(pinnedIcon.hb, pinnedIcon.pageX, pinnedIcon.pageY);
				opCanvas.style.cursor = overSegment ? "pointer" : "default";
			} else if (pinnedGap) {
				// keep showing the pinned gap while the mouse isn't over a
				// portrait bubble, instead of hiding it on every small move
				showBarGapTooltip(pinnedGap.seg, pinnedGap.pageX, pinnedGap.pageY);
				opCanvas.style.cursor = overSegment ? "pointer" : "default";
			} else {
				hideIconTooltip();
				opCanvas.style.cursor = overSegment ? "pointer" : "default";
			}
		});
		opCanvas.addEventListener("mouseleave", () => {
			if (!pinnedGap && !pinnedIcon) hideIconTooltip();
		});
		opCanvas.addEventListener("click", (e) => {
			const hb = findHoveredIcon(e.offsetX, e.offsetY);
			if (hb) {
				if (pinnedIcon && pinnedIcon.hb === hb) {
					// clicking the same portrait again unpins it
					pinnedIcon = null;
					hideIconTooltip();
				} else {
					pinnedIcon = { hb, pageX: e.pageX, pageY: e.pageY };
					pinnedGap = null;
					showIconTooltip(hb, e.pageX, e.pageY);
				}
				return;
			}
			const seg = findHoveredBarSegment(e.offsetX, e.offsetY);
			if (seg) {
				if (pinnedGap && pinnedGap.seg === seg) {
					// clicking the same segment again unpins it
					pinnedGap = null;
					hideIconTooltip();
				} else {
					pinnedGap = { seg, pageX: e.pageX, pageY: e.pageY };
					pinnedIcon = null;
					showBarGapTooltip(seg, e.pageX, e.pageY);
				}
			} else if (pinnedGap || pinnedIcon) {
				pinnedGap = null;
				pinnedIcon = null;
				hideIconTooltip();
			}
		});
		// a click anywhere outside the chart entirely (the canvas's own
		// click handler above only ever sees clicks that land on it) should
		// also dismiss a pinned gap/portrait tooltip
		document.addEventListener("click", (e) => {
			if ((pinnedGap || pinnedIcon) && !opCanvas.contains(e.target)) {
				pinnedGap = null;
				pinnedIcon = null;
				hideIconTooltip();
			}
		});
		// -----------------------------------------------------------------------

		let label, spacer; // reused for each button panel below
		const btns = document.createElement("div");
		btns.id = "barSort";
		btns.classList.add("sortdiv");
		document.getElementById("sortSelect").appendChild(btns);
		label = document.createElement("label");
		label.innerHTML = "Sort By:";
		btns.appendChild(label);

		for (const [n, sorter] of Object.entries(sorters)) {
			btn = document.createElement("div");
			btn.classList = "sorter button";
			if (n == sortName) btn.classList.add("checked");
			btn.dataset.name = n;
			btn.innerHTML = n;
			btns.appendChild(btn);
			btn.onclick = (e) => {
				labelSort = sorter;
				Array.from(btns.childNodes).forEach((x) =>
					x.classList.remove("checked"),
				);
				e.currentTarget.classList.toggle("checked");
				setPref("store", "sort", n);
				redrawCharts();
			};
		}

		var periodbtns = document.createElement("div");
		periodbtns.id = "barPeriods";
		periodbtns.classList.add("sortdiv");
		document.getElementById("periodSelect").appendChild(periodbtns);
		label = document.createElement("label");
		label.innerHTML = "Period:";
		periodbtns.appendChild(label);
		var start = SERVER_STARTS["CN"];
		var now = new Date();
		var diffYears = Math.floor((now - start) / (1000 * 60 * 60 * 24 * 365)); // full years
		// "Dynamic" always trims to whatever's actually visible (see
		// computeDynamicMin); the rest are fixed "always show exactly
		// this window" choices. Dynamic goes first and is the default.
		var periods = ["Dynamic"];
		for (var y = 2; y <= diffYears; y += 2) {
			periods.push(y + "y");
		}
		periods.push("ALL");
		periods.forEach(function (p) {
			var btn = document.createElement("div");
			btn.classList = "sorter button";
			if (p === selectedPeriod) btn.classList.add("checked");
			btn.dataset.period = p;
			btn.innerHTML = p;
			periodbtns.appendChild(btn);
			btn.onclick = function (e) {
				Array.from(periodbtns.childNodes).forEach(function (x) {
					x.classList.remove("checked");
				});
				e.currentTarget.classList.add("checked");

				selectedPeriod = p;
				setPref("store", "period", p);

				if (p === "Dynamic") {
					// redrawCharts() below computes and applies the min
					// itself every time it's called while Dynamic is
					// selected, so there's nothing to set here.
					redrawCharts();
					return;
				}

				// determine min based on period
				var minDate;
				if (p === "ALL") {
					minDate = SERVER_STARTS[selectedServer];
				} else {
					var yearsAgo = parseInt(p);
					minDate = new Date();
					minDate.setFullYear(minDate.getFullYear() - yearsAgo);
				}
				if (minDate < SERVER_STARTS[selectedServer]) {
					minDate = SERVER_STARTS[selectedServer];
				}
				barGraph.options.scales.x.min = minDate;
				barGraph.options.scales.x1.min = minDate;
				redrawCharts();
			};
		});

		const raritybtns = document.createElement("div");
		raritybtns.id = "barRarities";
		raritybtns.classList.add("sortdiv");
		document.getElementById("raritySelect").appendChild(raritybtns);
		label = document.createElement("label");
		label.innerHTML = "Show:";
		raritybtns.appendChild(label);
		for (const i of [3, 4, 5]) {
			btn = document.createElement("div");
			btn.classList = "sorter button";
			if (shownrarities.has(i)) btn.classList.add("checked");
			btn.dataset.name = 1 + i + "*";
			btn.innerHTML = 1 + i + "*";
			raritybtns.appendChild(btn);
			btn.onclick = (e) => {
				e.currentTarget.classList.toggle("checked");
				if (e.currentTarget.classList.contains("checked"))
					shownrarities.add(i);
				else shownrarities.delete(i);
				setPref("store", "rarities", Array.from(shownrarities));
				redrawCharts();
			};
		}
		spacer = document.createElement("span");
		spacer.innerHTML = "/";
		raritybtns.appendChild(spacer);
		for (const i of Object.keys(showntypes)) {
			btn = document.createElement("div");
			btn.classList = "sorter button checked";
			if (!showntypes[i]) btn.classList.remove("checked");
			btn.dataset.name = i;
			btn.innerHTML = i;
			raritybtns.appendChild(btn);
			btn.onclick = (e) => {
				e.currentTarget.classList.toggle("checked");
				showntypes[i] = e.currentTarget.classList.contains("checked");
				setPref("store", "types", Object.assign({}, showntypes));
				redrawCharts();
			};
		}

		// Only shown once there's actually a synced roster to grey against --
		// a toggle that would visibly do nothing stays hidden entirely, same
		// convention as the medals page's own "hide unobtainable" toggle.
		if (hasOwnedData) {
			const ownedSpacer = document.createElement("span");
			ownedSpacer.innerHTML = "/";
			raritybtns.appendChild(ownedSpacer);
			const ownedBtn = document.createElement("div");
			ownedBtn.classList = "sorter button";
			if (greyOutOwned) ownedBtn.classList.add("checked");
			ownedBtn.dataset.name = "Owned";
			ownedBtn.title = "Grey out operators already in your synced roster";
			ownedBtn.innerHTML = "Grey out owned";
			raritybtns.appendChild(ownedBtn);
			ownedBtn.onclick = (e) => {
				e.currentTarget.classList.toggle("checked");
				greyOutOwned = e.currentTarget.classList.contains("checked");
				setPref("store", "greyOwned", greyOutOwned);
				redrawCharts();
			};
		}

		const serverbtns = document.createElement("div");
		serverbtns.id = "barServers";
		serverbtns.classList.add("sortdiv");
		document.getElementById("localServerSelect").appendChild(serverbtns);
		label = document.createElement("label");
		label.innerHTML = "Server:";
		serverbtns.appendChild(label);
		Object.keys(SHOP_DATA).forEach((s) => {
			btn = document.createElement("div");
			btn.classList = "sorter button";
			if (s == selectedServer) btn.classList.add("checked");
			btn.dataset.name = s;
			btn.innerHTML = s;
			serverbtns.appendChild(btn);
			btn.onclick = (e) => {
				Array.from(serverbtns.childNodes).forEach((x) =>
					x.classList.remove("checked"),
				);
				e.currentTarget.classList.toggle("checked");
				selectedServer = s;
				setPref("store", "server", s);
				barGraph.data.datasets = getDatasets(SHOP_DATA[selectedServer]);
				// Only force the fixed-period range here -- if "Dynamic" is
				// selected, redrawCharts() below recomputes the min itself
				// from this server's now-current data, so setting it here
				// too would just get immediately overwritten.
				if (selectedPeriod !== "Dynamic") {
					// The selected fixed period (2y/4y/6y/ALL), measured on
					// this server -- not always the full range.
					const min = computeFixedPeriodMin(selectedPeriod, selectedServer);
					barGraph.options.scales.x.min = min;
					barGraph.options.scales.x1.min = min;
				}

				redrawCharts();
			};
		});
		// The server/filter/sort/period buttons are <div>s with click
		// handlers -- make them reachable and usable from the keyboard
		// (Tab, then Enter/Space), and tell screen readers which are on.
		const syncPressed = () => {
			for (const el of document.querySelectorAll(".btnPanel .button")) {
				el.setAttribute("role", "button");
				el.tabIndex = 0;
				el.setAttribute("aria-pressed", String(el.classList.contains("checked")));
			}
		};
		syncPressed();
		for (const panel of document.querySelectorAll(".btnPanel")) {
			panel.addEventListener("keydown", (e) => {
				if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("button")) {
					e.preventDefault();
					e.target.click();
				}
			});
			// Runs after the button's own onclick (which updates "checked").
			panel.addEventListener("click", syncPressed);
		}
		function redrawCharts() {
			// the rows/positions a pinned gap or portrait tooltip refers to
			// may no longer exist (or mean something different) after a
			// filter, sort, server or period change
			pinnedGap = null;
			pinnedIcon = null;
			hideIconTooltip();
			let subset = filterOperators(SHOP_DATA[selectedServer]);
			barGraph.data.labels = subset.sort(labelSort).map((x) => x.op);

			for (let i = 0; i < barGraph.data.datasets.length; i++)
				// remove elements not in labels
				barGraph.data.datasets[i].data = subset;

			// "Dynamic" recomputes the axis start every redraw (filter
			// change, sort, server switch, ...) so a narrower Show/rarity
			// selection never leaves a stretch of empty axis before the
			// first actually-visible bar. Fixed periods (2y/4y/6y/ALL) are
			// left as whatever the period button set, on purpose.
			if (selectedPeriod === "Dynamic") {
				const dynMin = computeDynamicMin(subset);
				barGraph.options.scales.x.min = dynMin;
				barGraph.options.scales.x1.min = dynMin;
			}

			adjustChartHeight(subset.length);

			barGraph.update();
		}
	})
	.catch((err) => {
		console.error("Couldn't load the shop history:", err);
		const el = document.getElementById("storeLoadError");
		el.textContent =
			"Couldn't load the shop history data. This is usually a brief network or GitHub hiccup -- try reloading the page in a minute.";
		el.hidden = false;
		document.getElementById("barChartContainer").hidden = true;
	});

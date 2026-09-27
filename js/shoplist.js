var operatorData;
const SHOP_DATA = {};
const OP_DATA = {};
// hit-testable regions for every portrait bubble drawn this frame, used to
// power the hover tooltip (populated in testp.beforeDatasetsDraw / afterDatasetDraw)
let iconHitboxes = [];
const showntypes = {
	Limited: false,
	Normal: true,
	Kernel: true,
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
fetch(
	"https://raw.githubusercontent.com/akgcc/akgcc-extra-data/main/json/banner_history.json",
)
	.then((res) => fixedJson(res))
	.then((js) => {
		SHOP_DATA.EN = js.NA;
		SHOP_DATA.CN = js.CN;
		return get_char_table(false, SERVERS.CN, true);
	})
	.then((js) => {
		operatorData = js;
		OP_DATA.CN = js;
		return get_char_table(false, SERVERS.EN, true);
	})
	.then((js) => {
		OP_DATA.EN = js;
		const SERVER_STARTS = {
			EN: Date.parse("2020-01-16"),
			CN: 1556582400000,
		};
		let selectedServer = "EN";
		var shownrarities = new Set([5]);
		for (const [serv, servdata] of Object.entries(SHOP_DATA)) {
			for (const [op, data] of Object.entries(servdata)) {
				let name = htmlDecode(op);
				data.op = SHORT_NAMES[name] || name;
				data.op = GAMEPRESS_NAME_MAP[data.op] || data.op;
				data.charId = charIdMap[data.op];
				if (data.charId == undefined) {
					if (!data.op.includes("APRIL FOOLS"))
						console.log("Operator not found:", data.op);
					delete servdata[op];
				} else {
					data.banner.sort(
						(a, b) => Date.parse(a.date) - Date.parse(b.date),
					);
					data.isKernel =
						OP_DATA[serv][data.charId]?.classicPotentialItemId !=
						null;
					const img = new Image();
					img.src = uri_avatar(data.charId);
					data.img = img;
					data.first = Date.parse(data.banner[0].date);
					data.shop = data.shop
						.map((entry) => ({
							...entry,
							date: Date.parse(entry.date),
						}))
						.sort((a, b) => a.date - b.date);
				}
			}
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
					let is_blue =
						chart.data.datasets[args.index].data[i].shop[
							parseInt(args.meta._dataset.parsing.xAxisKey)
						]?.blue;

					// if NaN this is the "first" index
					shop_idx = parseInt(args.meta._dataset.parsing.xAxisKey);
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
					ctx.drawImage(
						chart.data.datasets[args.index].data[i].img,
						-imgsize / 2,
						-imgsize / 2,
						imgsize,
						imgsize,
					);
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

					// record where this bubble landed on screen so mousemove
					// hit-testing can find it and show a date tooltip
					let pointDate = first_apperance
						? chart.data.datasets[args.index].data[i][
								args.meta._dataset.parsing.xAxisKey
							]
						: chart.data.datasets[args.index].data[i].shop[shop_idx]
								?.date;
					{
						let rowData = chart.data.datasets[args.index].data[i];
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
				axesPadding;
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
		//////////////////////////////////////////////////
		// this is just the contents of redrawCharts()
		let subset = filterOperators(SHOP_DATA[selectedServer]);
		var labels = subset.sort(labelSort).map((x) => x.op);
		var datasets = getDatasets(SHOP_DATA[selectedServer]);
		for (i = 0; i < datasets.length; i++)
			// remove elements not in labels
			datasets[i].data = subset;
		adjustChartHeight(subset.length);
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
						min: SERVER_STARTS[selectedServer],
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
						min: SERVER_STARTS[selectedServer],
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
		Promise.all(
			Object.values(SHOP_DATA[selectedServer]).map((x) => {
				return new Promise((resolve, reject) => {
					x.img.onload = resolve;
					x.img.onerror = reject;
				});
			}),
		).then((p) => {
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
		// Latest release date among Standard-pool (non-Kernel, non-Limited)
		// operators of a given remapped rarity, on the currently selected
		// server. Used to anchor the shop-debut prediction: the next
		// standard-pool op of that rarity is expected `cadence` weeks after
		// the *most recently released* one of that rarity, not after the
		// hovered operator's own (possibly much older) release date.
		function getLatestStandardPoolRelease(rarity) {
			let latest = -Infinity;
			for (const data of Object.values(SHOP_DATA[selectedServer])) {
				if (data.isKernel) continue;
				if (operatorData[data.charId]?.isLimited) continue;
				if (operatorData[data.charId]?.rarity !== rarity) continue;
				if (data.first > latest) latest = data.first;
			}
			return latest;
		}
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
				kind = "First released (not yet in shop)";
			} else if (hb.blue) {
				kind = "Shop rotation · Kernel pool";
			} else if (hb.isLimited) {
				kind = "Shop rotation · Limited pool";
			} else {
				kind = "Shop rotation · Standard pool";
			}

			// Standard-pool 5*/6* operators who have never appeared in the
			// shop yet: predict a debut date from a fixed weekly cadence.
			// (4* operators never get added to the shop, so no prediction.)
			const SHOP_DEBUT_CADENCE_WEEKS = { 5: 6, 4: 5 }; // rarity(remapped): weeks
			let predictionHtml = "";
			if (
				hb.first &&
				!hb.hasShopHistory &&
				!hb.isKernel &&
				!hb.isLimited &&
				SHOP_DEBUT_CADENCE_WEEKS[hb.rarity] != null
			) {
				const cadenceMs =
					SHOP_DEBUT_CADENCE_WEEKS[hb.rarity] * 7 * 24 * 60 * 60 * 1000;
				const latestRelease = getLatestStandardPoolRelease(hb.rarity);
				const predictedDate = new Date(latestRelease + cadenceMs);
				const predictedStr = predictedDate.toLocaleDateString(undefined, {
					year: "numeric",
					month: "short",
					day: "numeric",
				});
				predictionHtml =
					`<span style="opacity:0.8">Predicted shop debut: ~${predictedStr}</span>`;
			}

			iconTooltipEl.className = "";
			iconTooltipEl.classList.add("xcenter", "ybottom");
			iconTooltipEl.innerHTML =
				'<div style="display:flex;align-items:center;gap:8px;">' +
				`<img src="${uri_avatar(hb.charId)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">` +
				'<div style="display:flex;flex-direction:column;line-height:1.35;white-space:nowrap;">' +
				`<span><b>${hb.op}</b></span>` +
				`<span>${kind}</span>` +
				`<span style="opacity:0.8">${dateStr}</span>` +
				predictionHtml +
				"</div></div>";
			iconTooltipEl.style.left = pageX + "px";
			iconTooltipEl.style.top = pageY + "px";
			iconTooltipEl.style.transform = "translate(-50%, calc(-100% - 14px))";
		}
		function hideIconTooltip() {
			iconTooltipEl.classList.add("hidden");
			opCanvas.style.cursor = "default";
		}
		opCanvas.addEventListener("mousemove", (e) => {
			const hb = findHoveredIcon(e.offsetX, e.offsetY);
			if (hb) {
				showIconTooltip(hb, e.pageX, e.pageY);
				opCanvas.style.cursor = "pointer";
			} else {
				hideIconTooltip();
			}
		});
		opCanvas.addEventListener("mouseleave", hideIconTooltip);
		// -----------------------------------------------------------------------

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
			if (n == "Shop") btn.classList.add("checked");
			btn.dataset.name = n;
			btn.innerHTML = n;
			btns.appendChild(btn);
			btn.onclick = (e) => {
				labelSort = sorter;
				Array.from(btns.childNodes).forEach((x) =>
					x.classList.remove("checked"),
				);
				e.currentTarget.classList.toggle("checked");
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
		// generate 2-year increments
		var periods = [];
		for (var y = 2; y <= diffYears; y += 2) {
			periods.push(y + "y");
		}
		periods.push("ALL");
		periods.forEach(function (p) {
			var btn = document.createElement("div");
			btn.classList = "sorter button";
			if (p === "ALL") btn.classList.add("checked");
			btn.dataset.period = p;
			btn.innerHTML = p;
			periodbtns.appendChild(btn);
			btn.onclick = function (e) {
				Array.from(periodbtns.childNodes).forEach(function (x) {
					x.classList.remove("checked");
				});
				e.currentTarget.classList.add("checked");

				selectedPeriod = p;

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
			if (i == 5) btn.classList.add("checked");
			btn.dataset.name = 1 + i + "*";
			btn.innerHTML = 1 + i + "*";
			raritybtns.appendChild(btn);
			btn.onclick = (e) => {
				e.currentTarget.classList.toggle("checked");
				if (e.currentTarget.classList.contains("checked"))
					shownrarities.add(i);
				else shownrarities.delete(i);
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
			if (s == "EN") btn.classList.add("checked");
			btn.dataset.name = s;
			btn.innerHTML = s;
			serverbtns.appendChild(btn);
			btn.onclick = (e) => {
				Array.from(serverbtns.childNodes).forEach((x) =>
					x.classList.remove("checked"),
				);
				e.currentTarget.classList.toggle("checked");
				selectedServer = s;
				barGraph.data.datasets = getDatasets(SHOP_DATA[selectedServer]);
				barGraph.options.scales.x.min = SERVER_STARTS[selectedServer];
				barGraph.options.scales.x1.min = SERVER_STARTS[selectedServer];

				redrawCharts();
			};
		});
		function redrawCharts() {
			let subset = filterOperators(SHOP_DATA[selectedServer]);
			barGraph.data.labels = subset.sort(labelSort).map((x) => x.op);

			for (i = 0; i < barGraph.data.datasets.length; i++)
				// remove elements not in labels
				barGraph.data.datasets[i].data = subset;
			adjustChartHeight(subset.length);

			barGraph.update();
		}
	});

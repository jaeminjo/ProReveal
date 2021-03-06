import * as d3 from 'd3';
import { Constants as C, Constants } from '../../constants';
import * as util from '../../util';
import { AggregateQuery, Histogram2DQuery } from '../../data/query';
import { measure } from '../../d3-utils/measure';
import { translate, selectOrAppend } from '../../d3-utils/d3-utils';
import { QuantitativeField } from '../../data/field';
import { TooltipComponent } from '../../tooltip/tooltip.component';
import * as vsup from 'vsup';
import { VisComponent } from '../vis.component';
import { ConstantTrait, ValueConstant, RangeConstant, LinearRegressionConstant } from '../../safeguard/constant';
import { SafeguardTypes as SGT } from '../../safeguard/safeguard';
import { CombinedVariable, SingleVariable } from '../../safeguard/variable';
import { HeatmapTooltipComponent } from './heatmap-tooltip.component';
import { Gradient } from '../errorbars/gradient';
import { NullGroupId } from '../../data/grouper';
import { Datum } from '../../data/datum';
import { AngularBrush, AngularBrushMode } from './angular-brush';
import { AndPredicate } from '../../data/predicate';
import { LinearLine } from './linear-line';
import { LoggerService, LogType } from '../../services/logger.service';
import { FieldGroupedValue } from '../../data/field-grouped-value';
import { EmptyConfidenceInterval } from '../../data/confidence-interval';

type Range = [number, number];

export class HeatmapRenderer {
    gradient = new Gradient();
    data: Datum[];
    xScale: d3.ScaleBand<string>;
    yScale: d3.ScaleBand<string>;
    matrixWidth: number;
    header: number;

    variable1: CombinedVariable;
    variable2: CombinedVariable;
    query: AggregateQuery;
    nativeSvg: SVGSVGElement;
    legendXScale: d3.ScaleLinear<number, number>; // value -> pixel
    angularBrush = new AngularBrush();
    linearLine = new LinearLine();

    eventBoxes: d3.Selection<d3.BaseType, Datum, d3.BaseType, {}>;
    swatch: d3.Selection<d3.BaseType, Datum, d3.BaseType, {}>;
    visG;
    interactionG;
    xValuesCount: number;
    yValuesCount: number;

    xTopLabels: d3.Selection<d3.BaseType, FieldGroupedValue, d3.BaseType, {}>;
    xBottomLabels: d3.Selection<d3.BaseType, FieldGroupedValue, d3.BaseType, {}>;
    yLabels: d3.Selection<d3.BaseType, FieldGroupedValue, d3.BaseType, {}>;

    limitNumCategories = true;

    constructor(public vis: VisComponent, public tooltip: TooltipComponent, public logger: LoggerService) {
    }

    setup(query: AggregateQuery, nativeSvg: SVGSVGElement, floatingSvg: HTMLDivElement) {
        if (query.groupBy.fields.length !== 2) {
            throw 'Heatmaps can be used for 2 categories!';
        }

        let svg = d3.select(nativeSvg);

        this.gradient.setup(selectOrAppend(svg, 'defs'));
        this.visG = selectOrAppend(svg, 'g', 'vis');

        this.visG.classed('heatmap', true);

        this.query = query;
        this.nativeSvg = nativeSvg;

        this.interactionG = selectOrAppend(svg, 'g', 'interaction').classed('heatmap', true);

        let fsvgw = d3.select(floatingSvg);
        let fbrush = fsvgw.select('.angular-brush');
        this.angularBrush.setup(fbrush);
        this.linearLine.setup(this.interactionG);
    }

    render(query: AggregateQuery, nativeSvg: SVGSVGElement, floatingSvg: HTMLDivElement) {
        let visG = d3.select(nativeSvg).select('g.vis');

        let data = query.getVisibleData();
        this.data = data;

        let xKeys = {}, yKeys = {};

        data.forEach(row => {
            xKeys[row.keys.list[0].hash] = row.keys.list[0];
            yKeys[row.keys.list[1].hash] = row.keys.list[1];
        });

        let xValues: FieldGroupedValue[] = d3.values(xKeys);
        let yValues: FieldGroupedValue[] = d3.values(yKeys);

        this.xValuesCount = xValues.length;
        this.yValuesCount = yValues.length;

        if (this.query instanceof Histogram2DQuery) {
            let sortFunc = (a: FieldGroupedValue, b: FieldGroupedValue) => {
                let av = a.value(), bv = b.value();

                if (a.groupId === NullGroupId) return 1;
                if (b.groupId === NullGroupId) return -1;

                let ap = av ? av[0] as number : (a.field as QuantitativeField).max;
                let bp = bv ? bv[0] as number : (b.field as QuantitativeField).max;

                return ap - bp;
            }
            xValues.sort(sortFunc)
            yValues.sort(sortFunc);

            //yValues = yValues.reverse();
        }
        else {
            let weight = {}, count = {};
            data.forEach(row => {
                function accumulate(dict, key, value) {
                    if (!dict[key]) dict[key] = 0;
                    dict[key] += value;
                }

                accumulate(weight, row.keys.list[0].hash, row.ci3.center);
                accumulate(weight, row.keys.list[1].hash, row.ci3.center);
                accumulate(count, row.keys.list[0].hash, 1);
                accumulate(count, row.keys.list[1].hash, 1);
            })

            for (let key in weight) { weight[key] /= count[key]; }

            let sortFunc = (a: FieldGroupedValue, b: FieldGroupedValue) => {
                if (a.groupId === NullGroupId) return 1;
                if (b.groupId === NullGroupId) return -1;
                return weight[b.hash] - weight[a.hash];
            }

            xValues.sort(sortFunc);
            yValues.sort(sortFunc);
        }

        if (this.limitNumCategories) {
            xValues = xValues.slice(0, C.heatmap.initiallyVisibleCategories);
            yValues = yValues.slice(0, C.heatmap.initiallyVisibleCategories);

            let xKeys = {}, yKeys = {};
            xValues.forEach(v => xKeys[v.hash] = true);
            yValues.forEach(v => yKeys[v.hash] = true);

            data = data.filter(d => xKeys[d.keys.list[0].hash] && yKeys[d.keys.list[1].hash]);
        }

        const yLabelWidth = d3.max(yValues, v => measure('~' + v.valueString()).width) || 0;
        const xLabelWidth = d3.max(xValues, v => measure('~' + v.valueString()).width) || 0;

        const xFieldLabelHeight = C.heatmap.label.x.height;
        const yFieldLabelWidth = C.heatmap.label.y.width;

        const header = 1.414 / 2 * (C.heatmap.columnWidth + xLabelWidth) + xFieldLabelHeight
        const height = C.heatmap.rowHeight * yValues.length + header * 2;

        const matrixWidth = xValues.length > 0 ?
            (yFieldLabelWidth + yLabelWidth + C.heatmap.columnWidth * (xValues.length - 1) + header) : 0;
        const width = matrixWidth + C.heatmap.legendSize * 1.2;

        this.matrixWidth = matrixWidth;

        d3.select(nativeSvg).attr('width', width)
            .attr('height', Math.max(height, C.heatmap.legendSize + C.heatmap.legendPadding * 2));

        const xScale = d3.scaleBand().domain(xValues.map(d => d.hash))
            .range([yFieldLabelWidth + yLabelWidth, matrixWidth - header]);

        const yScale = d3.scaleBand().domain(yValues.map(d => d.hash))
            .range([header, height - header]);

        this.header = header;
        this.xScale = xScale;
        this.yScale = yScale;

        // render top and bottom labels
        {
            // x labels
            selectOrAppend(visG, 'text', '.x.field.label.top')
                .text(query.groupBy.fields[0].name)
                .attr('transform', translate(matrixWidth / 2, 0))
                .style('text-anchor', 'middle')
                .attr('dy', '1.1em')
                .style('font-size', '.8rem')
                .style('font-style', 'italic')

            selectOrAppend(visG, 'text', '.x.field.label.bottom')
                .text(query.groupBy.fields[0].name)
                .attr('transform', translate(matrixWidth / 2, height - C.bars.axis.height))
                .style('text-anchor', 'middle')
                .attr('dy', '1.3em')
                .style('font-size', '.8rem')
                .style('font-style', 'italic')

            selectOrAppend(visG, 'text', '.y.field.label')
                .text(query.groupBy.fields[1].name)
                .attr('transform',
                    translate(0, height / 2) + 'rotate(-90)')
                .style('text-anchor', 'middle')
                .attr('dy', '1em')
                .style('font-size', '.8rem')
                .style('font-style', 'italic')
        }

        let enter: any;

        { // y labels
            const yLabels = visG
                .selectAll('text.label.y.data')
                .data(yValues, (d: FieldGroupedValue) => d.hash);

            enter = yLabels.enter().append('text').attr('class', 'label y data')
                .style('text-anchor', 'end')
                .attr('font-size', '.8rem')
                .attr('dy', '.8rem')

            this.yLabels = yLabels.merge(enter)
                .attr('transform', (d) => translate(yFieldLabelWidth + yLabelWidth - C.padding, yScale(d.hash)))
                .text(d => d.valueString())

            yLabels.exit().remove();

        }

        { // x labels
            const xTopLabels = visG
                .selectAll('text.label.top.x.data')
                .data(xValues, (d: FieldGroupedValue) => d.hash);

            enter = xTopLabels.enter().append('text').attr('class', 'label x top data')
                .style('text-anchor', 'start')
                .attr('font-size', '.8rem')

            this.xTopLabels = xTopLabels.merge(enter)
                .attr('transform', (d) =>
                    translate(xScale(d.hash) + xScale.bandwidth() / 2, header - C.padding) + 'rotate(-45)')
                .text(d => d.valueString())

            xTopLabels.exit().remove();

            const xBottomLabels = visG
                .selectAll('text.label.x.bottom.data')
                .data(xValues, (d: FieldGroupedValue) => d.hash);

            enter = xBottomLabels.enter().append('text').attr('class', 'label x bottom data')
                .style('text-anchor', 'start')
                .attr('font-size', '.8rem')

            this.xBottomLabels = xBottomLabels.merge(enter)
                .attr('transform', (d) =>
                    translate(xScale(d.hash) + xScale.bandwidth() / 2, height - header + yScale.bandwidth() / 2) + 'rotate(45)')
                .text(d => d.valueString())

            xBottomLabels.exit().remove();
        }

        const xMin = (query as AggregateQuery).approximator.alwaysNonNegative ? 0 : d3.min(data, d => d.ci3.low);
        const xMax = d3.max(data, d => d.ci3.high);

        const niceTicks = d3.ticks(xMin, xMax, 8);
        const step = niceTicks[1] - niceTicks[0];
        const domainStart = (query as AggregateQuery).approximator.alwaysNonNegative ? Math.max(0, niceTicks[0] - step) : (niceTicks[0] - step);
        const domainEnd = niceTicks[niceTicks.length - 1] + step;

        if (query.domainStart > domainStart) query.domainStart = domainStart;
        if (query.domainEnd < domainEnd) query.domainEnd = domainEnd;

        let maxUncertainty = d3.max(data, d => d.ci3.stdev);

        if (query.maxUncertainty < maxUncertainty) query.maxUncertainty = maxUncertainty;

        maxUncertainty = query.maxUncertainty;

        let quant = vsup.quantization().branching(2).layers(4)
            .valueDomain([domainStart, domainEnd])
            .uncertaintyDomain([0, maxUncertainty]);

        let viridis = d3.interpolateViridis;
        let zScale = vsup.scale()
            .quantize(quant)
            // .range(t => viridis(1 - t));

        const rects = visG
            .selectAll('rect.area')
            .data(data, (d: any) => d.id);

        enter = rects
            .enter().append('rect').attr('class', 'area')

        rects.merge(enter)
            .attr('height', yScale.bandwidth())
            .attr('width', xScale.bandwidth())
            .attr('transform', (d) => {
                return translate(xScale(d.keys.list[0].hash), yScale(d.keys.list[1].hash))
            })
            .attr('fill', d => d.ci3 === EmptyConfidenceInterval ?
                'transparent' :
                zScale(d.ci3.center, d.ci3.high - d.ci3.center)
            );

        rects.exit().remove();


        // horizontal lines (grid)

        let hls = visG.selectAll('line.horizontal')
            .data(d3.range(yValues.length + 1))

        enter = hls.enter().append('line').attr('class', 'horizontal')
            .style('stroke', 'black')
            .style('stroke-opacity', 0.1)
            .style('pointer-events', 'none')

        hls.merge(enter)
            .attr('x1', yFieldLabelWidth + yLabelWidth)
            .attr('y1', (d, i) => header + C.heatmap.rowHeight * i)
            .attr('x2', matrixWidth - header)
            .attr('y2', (d, i) => header + C.heatmap.rowHeight * i)

        hls.exit().remove();

        // vertical lines (grid)
        let vls = visG.selectAll('line.vertical')
            .data(d3.range(xValues.length + 1))

        enter = vls.enter().append('line').attr('class', 'vertical')
            .style('stroke', 'black')
            .style('stroke-opacity', 0.1)
            .style('pointer-events', 'none')

        let xbw = this.xScale.bandwidth();
        vls.merge(enter)
            .attr('x1', (d, i) => yFieldLabelWidth + yLabelWidth + xbw * i)
            .attr('y1', (d, i) => header)
            .attr('x2', (d, i) => yFieldLabelWidth + yLabelWidth + xbw * i)
            .attr('y2', (d, i) => height - header)

        vls.exit().remove();

        let eventBoxes = this.interactionG
            .selectAll('rect.event-box')
            .data(data, (d: Datum) => d.id);

        enter = eventBoxes
            .enter().append('rect').attr('class', 'event-box variable1')

        this.eventBoxes = eventBoxes.merge(enter)
            .attr('height', yScale.bandwidth())
            .attr('width', xScale.bandwidth())
            .attr('transform', (d) => {
                return translate(xScale(d.keys.list[0].hash), yScale(d.keys.list[1].hash))
            })
            .attr('fill', 'transparent')
            .style('cursor', (d) => d.ci3 === EmptyConfidenceInterval ? 'auto' : 'pointer')
            .on('mouseenter', (d, i) => {
                this.showTooltip(d);

                this.xTopLabels.filter(fgv => fgv.hash == d.keys.list[0].hash).classed('hover', true);
                this.xBottomLabels.filter(fgv => fgv.hash == d.keys.list[0].hash).classed('hover', true);
                this.yLabels.filter(fgv => fgv.hash == d.keys.list[1].hash).classed('hover', true);
            })
            .on('mouseleave', (d, i) => {
                this.hideTooltip();

                this.xTopLabels.filter(fgv => fgv.hash == d.keys.list[0].hash).classed('hover', false);
                this.xBottomLabels.filter(fgv => fgv.hash == d.keys.list[0].hash).classed('hover', false);
                this.yLabels.filter(fgv => fgv.hash == d.keys.list[1].hash).classed('hover', false);
            })
            .on('click', (d, i, ele) => {
                if (d.ci3 == EmptyConfidenceInterval) return;
                this.datumSelected(d);
                this.toggleDropdown(d, i);

                let d3ele = d3.select(ele[i]);
                d3ele.classed('menu-highlighted', this.vis.selectedDatum === d);

                this.xTopLabels.filter(fgv => fgv.hash == d.keys.list[0].hash).classed('menu-highlighted', this.vis.selectedDatum === d);
                this.xBottomLabels.filter(fgv => fgv.hash == d.keys.list[0].hash).classed('menu-highlighted', this.vis.selectedDatum === d);
                this.yLabels.filter(fgv => fgv.hash == d.keys.list[1].hash).classed('menu-highlighted', this.vis.selectedDatum === d);
            })
            .on('contextmenu', (d) => this.datumSelected2(d))

        eventBoxes.exit().remove();

        // vertical lines (grid)
        const size = C.heatmap.legendSize;
        const padding = C.heatmap.legendPadding;
        let legend = vsup.legend.arcmapLegend()
            .scale(zScale).size(size)
                .utitle(Constants.locale.HeatmapLegendUncertainty)
                .vtitle(Constants.locale.HeatmapLedgendValue)

        let floatingSvgWrapper = d3.select(floatingSvg);
        let floatingLegend = floatingSvgWrapper.select('.legend');
        let floatingBrush = floatingSvgWrapper.select('.angular-brush');

        let parentWidth = nativeSvg.parentElement.offsetWidth;
        let parentOffsetTop = 100 + header; // nativeSvg.getBoundingClientRect().top; // TODO
        floatingLegend.attr('width', size + 2 * padding).attr('height', size + 3 * padding);
        floatingBrush.attr('width', size + 2 * padding).attr('height', size + 3 * padding);

        d3.select(floatingSvg).style('display', 'block');

        selectOrAppend(floatingLegend, 'g', '.z.legend').selectAll('*').remove();
        selectOrAppend(floatingLegend, 'g', '.z.legend')
            .attr('transform', translate(padding, 2 * padding))
            .append('g')
            .call(legend);

        selectOrAppend(visG, 'g', '.z.legend').remove();


        if (matrixWidth + size + padding * 2 > parentWidth) {
            floatingSvgWrapper
                .style('position', 'sticky')
                .style('left', `${parentWidth - size - padding * 3}px`)
                .style('bottom', `${C.padding}px`)
                .style('top', 'auto')
        }
        else {
            floatingSvgWrapper
                .style('position', 'absolute')
                .style('left', `${matrixWidth}px`)
                .style('top', `${parentOffsetTop}px`)
                .style('bottom', 'auto')
        }

        this.angularBrush.on('brush', (centerOrRange) => {
            if (this.safeguardType === SGT.Value) {
                let constant = new ValueConstant(this.legendXScale.invert(centerOrRange));
                this.constant = constant;
                this.vis.constantSelected.emit(constant);
            }
            else if (this.safeguardType === SGT.Range) {
                let [center, from, to] = centerOrRange as [number, number, number];
                let constant = new RangeConstant(
                    this.legendXScale.invert(center),
                    this.legendXScale.invert(from),
                    this.legendXScale.invert(to));
                this.constant = constant;
                this.vis.constantSelected.emit(constant);
            }
        })

        let legendXScale = d3.scaleLinear().domain(quant.valueDomain())
            .range([padding, size + padding]);
        this.legendXScale = legendXScale;

        if (this.safeguardType == SGT.Value || this.safeguardType === SGT.Range) {
            this.angularBrush.render([[padding, 2 * padding], [size + padding, size + 2 * padding]]);
        }

        if (!this.constant) this.setDefaultConstantFromVariable();

        if ([SGT.Value, SGT.Range].includes(this.safeguardType) && this.constant)
            this.angularBrush.show();
        else
            this.angularBrush.hide();


        if(this.variable1 && this.safeguardType === SGT.Value) {
            let d = this.getDatum(this.variable1);
            this.angularBrush.setReferenceValue(this.legendXScale(d.ci3.center));

            if(this.constant) {
                let center = this.legendXScale((this.constant as ValueConstant).value);
                this.angularBrush.move(center);
            }
        }
        else if(this.variable1 && this.safeguardType == SGT.Range) {
            let d = this.getDatum(this.variable1);
            this.angularBrush.setReferenceValue(this.legendXScale(d.ci3.center));
            this.angularBrush.setCenter(this.legendXScale(d.ci3.center));

            if(this.constant) {
                let oldRange: Range = (this.constant as RangeConstant).range;
                let half = (oldRange[1] - oldRange[0]) / 2;
                let newCenter = this.getDatum(this.variable1).ci3.center;
                let domain = this.legendXScale.domain();

                if(newCenter - half < domain[0]) { half = newCenter - domain[0]; }
                if(newCenter + half > domain[1]) { half = Math.min(half, domain[1] - newCenter); }

                let constant = new RangeConstant(newCenter, newCenter - half, newCenter + half);
                this.vis.constantSelected.emit(constant);
                this.constantUserChanged(constant); // calls brush.move
            }
        }

        if (this.safeguardType === SGT.Linear) {
            this.linearLine.show();
            this.linearLine.render(
                this.constant as LinearRegressionConstant,
                xKeys,
                yKeys,
                xScale,
                yScale
            );
        }
        else {
            this.linearLine.hide();
        }
    }

    constant: ConstantTrait;

    safeguardType: SGT = SGT.None;
    setSafeguardType(st: SGT) {
        this.safeguardType = st;

        this.variable1 = null;
        this.variable2 = null;
        this.constant = null;
        this.updateHighlight();

        if (st == SGT.None) {
        }
        else if (st == SGT.Value) {
            this.angularBrush.setMode(AngularBrushMode.Point);
        }
        else if (st === SGT.Range) {
            this.angularBrush.setMode(AngularBrushMode.SymmetricRange);
        }
        else if (st === SGT.Comparative) {
        }
    }

    updateHighlight() {
        this.eventBoxes
            .classed('stroke-highlighted', false)
            .filter((d) =>
                this.variable1 && this.variable1.hash === d.keys.hash ||
                this.variable2 && this.variable2.hash === d.keys.hash
            )
            .classed('stroke-highlighted', true)

        this.xTopLabels
            .classed('highlighted', false)
            .filter((d) => (this.variable1 && this.variable1.first.fieldGroupedValue.hash === d.hash) ||
                    (this.variable2 && this.variable2.first.fieldGroupedValue.hash === d.hash)
            )
            .classed('highlighted', true)

        this.xBottomLabels
            .classed('highlighted', false)
            .filter((d) => (this.variable1 && this.variable1.first.fieldGroupedValue.hash === d.hash) ||
                    (this.variable2 && this.variable2.first.fieldGroupedValue.hash === d.hash)
            )
            .classed('highlighted', true)

        this.yLabels
            .classed('highlighted', false)
            .filter((d) => (this.variable1 && this.variable1.second.fieldGroupedValue.hash === d.hash) ||
                    (this.variable2 && this.variable2.second.fieldGroupedValue.hash === d.hash)
            )
            .classed('highlighted', true)

        this.eventBoxes
            .classed('variable2', false)
            .filter((d) => this.variable2 && this.variable2.hash === d.keys.hash)
            .classed('variable2', true)

        this.xTopLabels
            .classed('variable2', false)
            .filter((d) => this.variable2 && this.variable2.first.fieldGroupedValue.hash === d.hash)
            .classed('variable2', true)

        this.xBottomLabels
            .classed('variable2', false)
            .filter((d) => this.variable2 && this.variable2.first.fieldGroupedValue.hash === d.hash)
            .classed('variable2', true)

        this.yLabels
            .classed('variable2', false)
            .filter((d) => this.variable2 && this.variable2.second.fieldGroupedValue.hash === d.hash)
            .classed('variable2', true)
    }

    /* invoked when a constant is selected indirectly (by clicking on a category) */
    constantUserChanged(constant: ConstantTrait) {
        this.constant = constant;
        if (this.safeguardType === SGT.Value) {
            let center = this.legendXScale((constant as ValueConstant).value);
            this.angularBrush.show();
            this.angularBrush.move(center);
        }
        else if (this.safeguardType === SGT.Range) {
            let range = (constant as RangeConstant).range.map(this.legendXScale) as [number, number];
            this.angularBrush.show();
            this.angularBrush.move(range);
        }
    }

    getDatum(variable: CombinedVariable): Datum {
        return this.data.find(d => d.id === variable.hash);
    }

    getRank(variable: CombinedVariable): number {
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i].id == variable.hash) return i + 1;
        }
        return 1;
    }

    datumSelected(d: Datum) {
        if (![SGT.Value, SGT.Range, SGT.Comparative].includes(this.safeguardType)) return;

        this.logger.log(LogType.DatumSelected, {
            datum: d.toLog(),
            data: this.data.map(d => d.toLog())
        });

        let variable = new CombinedVariable(
            new SingleVariable(d.keys.list[0]),
            new SingleVariable(d.keys.list[1]));
        if (this.variable2 && variable.hash === this.variable2.hash) return;
        this.variable1 = variable;

        if (this.safeguardType === SGT.Value) {
            this.angularBrush.setReferenceValue(this.legendXScale(d.ci3.center));
        }
        else if (this.safeguardType === SGT.Range) {
            this.angularBrush.setCenter(this.legendXScale(d.ci3.center));
            this.angularBrush.setReferenceValue(this.legendXScale(d.ci3.center));
        }
        this.updateHighlight();

        this.vis.variableSelected.emit({ variable: variable });
        this.setDefaultConstantFromVariable(true);
    }

    datumSelected2(d: Datum) {
        if (this.safeguardType != SGT.Comparative) return;
        d3.event.preventDefault();

        this.logger.log(LogType.DatumSelected, {
            datum: d.toLog(),
            data: this.data.map(d => d.toLog())
        });

        let variable = new CombinedVariable(
            new SingleVariable(d.keys.list[0]),
            new SingleVariable(d.keys.list[1]));

        if (this.variable1 && variable.hash === this.variable1.hash)
            return;
        this.variable2 = variable;
        this.updateHighlight();

        this.vis.variableSelected.emit({
            variable: variable,
            secondary: true
        });
    }

    setDefaultConstantFromVariable(removeCurrentConstant = false) {
        if (removeCurrentConstant) this.constant = null;
        if (this.constant) return;
        if (this.variable1) {
            if (this.safeguardType === SGT.Value) {
                let constant = new ValueConstant(this.getDatum(this.variable1).ci3.center);
                this.vis.constantSelected.emit(constant);
                this.constantUserChanged(constant);
            }
            else if (this.safeguardType === SGT.Range) {
                let range = this.getDatum(this.variable1).ci3;
                let constant = new RangeConstant(range.center, range.low, range.high);

                if (range.low < 0) constant = new RangeConstant(range.center, 0, range.high + range.low);
                this.vis.constantSelected.emit(constant);
                this.constantUserChanged(constant);
            }
        }
        else if (this.safeguardType === SGT.Linear) {
            let constant = LinearRegressionConstant.FitFromVisData(this.query.getVisibleData(), 0, 1);
            this.vis.constantSelected.emit(constant);
            this.constantUserChanged(constant);
        }
    }

    showTooltip(d: Datum) {
        if(d.ci3 === EmptyConfidenceInterval) return;

        const clientRect = this.nativeSvg.getBoundingClientRect();
        const parentRect = this.nativeSvg.parentElement.getBoundingClientRect();


        let data = {
            query: this.query,
            datum: d
        };

        this.tooltip.show(
            clientRect.left - parentRect.left + this.xScale(d.keys.list[0].hash) +
            this.xScale.bandwidth() / 2,
            clientRect.top - parentRect.top + this.yScale(d.keys.list[1].hash),
            HeatmapTooltipComponent,
            data
        );
    }

    hideTooltip() {
        this.tooltip.hide();
    }

    toggleDropdown(d: Datum, i: number) {
        d3.event.stopPropagation();

        if ([SGT.Value, SGT.Range, SGT.Comparative].includes(this.safeguardType)) return;
        if (this.vis.isDropdownVisible || this.vis.isQueryCreatorVisible) {
            this.closeDropdown();
            return;
        }

        if (d == this.vis.selectedDatum) { // double click the same item
            this.closeDropdown();
        }
        else {
            this.openDropdown(d);
            return;
        }
    }

    openDropdown(d: Datum) {
        this.vis.selectedDatum = d;

        const clientRect = this.nativeSvg.getBoundingClientRect();
        const parentRect = this.nativeSvg.parentElement.getBoundingClientRect();

        let i = this.data.indexOf(d);
        let top = clientRect.top - parentRect.top
            + this.yScale(d.keys.list[1].hash) + this.yScale.bandwidth();

        this.vis.isDropdownVisible = true;
        this.vis.dropdownTop = top;
        this.vis.dropdownLeft = this.xScale(d.keys.list[0].hash) + this.xScale.bandwidth();
    }

    closeDropdown() {
        this.vis.emptySelectedDatum();
        this.vis.isQueryCreatorVisible = false;
        this.vis.isDropdownVisible = false;
    }

    openQueryCreator(d: Datum) {
        if (this.safeguardType != SGT.None) return;

        const clientRect = this.nativeSvg.getBoundingClientRect();
        const parentRect = this.nativeSvg.parentElement.getBoundingClientRect();

        let i = this.data.indexOf(d);
        let left = clientRect.left - parentRect.left
            + this.xScale(d.keys.list[0].hash) + this.xScale.bandwidth() / 2;
        let top = clientRect.top - parentRect.top + this.yScale(d.keys.list[1].hash);

        this.vis.isQueryCreatorVisible = true;
        this.vis.queryCreatorTop = top;
        this.vis.queryCreatorLeft = left;

        let where: AndPredicate = this.vis.query.where;
        // where + datum

        where = where.and(this.query.getPredicateFromDatum(d));
        this.vis.queryCreator.where = where;
    }

    closeQueryCreator() {
        this.vis.isQueryCreatorVisible = false;
    }

    emptySelectedDatum() {
        this.eventBoxes.classed('menu-highlighted', false);
        this.xTopLabels.classed('menu-highlighted', false);
        this.xBottomLabels.classed('menu-highlighted', false);
        this.yLabels.classed('menu-highlighted', false);
    }
}

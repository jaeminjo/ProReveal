import * as d3 from 'd3';
import { ExplorationNode } from '../../exploration/exploration-node';
import { VisConstants as VC } from '../vis-constants';
import * as util from '../../util';
import { AggregateQuery } from '../../data/query';
import { measure } from '../../d3-utils/measure';
import { translate, selectOrAppend } from '../../d3-utils/d3-utils';
import { Gradient } from '../errorbars/gradient';
import { FieldGroupedValueList } from '../../data/field';
import { ConfidenceInterval } from '../../data/approx';
import { Renderer } from './renderer';
import { TooltipComponent } from '../../tooltip/tooltip.component';
import { HorizontalBarsTooltipComponent } from './horizontal-bars-tooltip.component';
import { Safeguard, SafeguardTypes as SGT} from '../../safeguard/safeguard';
import { SingleVariable, VariableTypes as VT } from '../../safeguard/variable';
import { Operators } from '../../safeguard/operator';
import { VisComponent } from '../vis.component';
import { ScaleLinear } from 'd3';
import { ConstantTrait, PointRankConstant, PointValueConstant, RangeRankConstant, RangeValueConstant } from '../../safeguard/constant';
import { FlexBrush, FlexBrushDirection, FlexBrushMode } from './brush';

type Datum = {
    id: string,
    keys: FieldGroupedValueList,
    ci3stdev: ConfidenceInterval
};

export class HorizontalBarsRenderer implements Renderer {
    gradient = new Gradient();
    yScale: d3.ScaleBand<string>;
    data: Datum[];
    node: ExplorationNode;
    nativeSvg: SVGSVGElement;
    variable1: SingleVariable;
    variable2: SingleVariable;
    labelWidth: number;
    width: number;
    flexBrush = new FlexBrush<Datum>();

    labels: d3.Selection<d3.BaseType, Datum, d3.BaseType, {}>;
    ranks: d3.Selection<d3.BaseType, Datum, d3.BaseType, {}>;
    eventBoxes: d3.Selection<d3.BaseType, Datum, d3.BaseType, {}>;
    variableHighlight: d3.Selection<d3.BaseType, {}, null, undefined>;
    variableHighlight2: d3.Selection<d3.BaseType, {}, null, undefined>;
    constantHighlight: d3.Selection<d3.BaseType, {}, d3.BaseType, {}>;
    xScale: ScaleLinear<number, number>;

    visG;
    interactionG;

    constructor(public vis:VisComponent, public tooltip:TooltipComponent) {
    }

    setup(node: ExplorationNode, nativeSvg: SVGSVGElement) {
        if ((node.query as AggregateQuery).groupBy.fields.length > 1) {
            throw 'HorizontalBars can be used up to 1 groupBy';
        }

        let svg = d3.select(nativeSvg);

        this.gradient.setup(selectOrAppend(svg, 'defs'));
        this.visG = selectOrAppend(svg, 'g', 'vis');

        this.node = node;
        this.nativeSvg = nativeSvg;

        this.interactionG = selectOrAppend(svg, 'g', 'interaction');
        this.flexBrush.setup(this.interactionG);
    }

    render(node: ExplorationNode, nativeSvg: SVGSVGElement) {
        let svg = d3.select(nativeSvg);
        let query = node.query as AggregateQuery;
        let processedPercent = query.progress.processedPercent();
        let done = query.progress.done();
        let visG = svg.select('g.vis');

        let data = query.resultList().map(
            value => {
                const ai = query.accumulator
                    .approximate(value[1], processedPercent, query.dataset.length);

                return {
                    id: value[0].hash,
                    keys: value[0],
                    ci3stdev: ai.range(3)
                };
            });

        data.sort(node.ordering(query.defaultOrderingGetter, query.defaultOrderingDirection));
        this.data = data;

        const height = VC.horizontalBars.axis.height * 2 +
            VC.horizontalBars.height * data.length;
        const width = 800;

        svg.attr('width', width).attr('height', height)
            .on('contextmenu', () => d3.event.preventDefault());

        let [, longest,] = util.amax(data, d => d.keys.list[0].valueString().length + 4 /* rank */);
        const labelWidth = longest ? measure(longest.keys.list[0].valueString()).width : 0;

        const xMin = (query as AggregateQuery).accumulator.alwaysNonNegative ? 0 : d3.min(data, d => d.ci3stdev.low);
        const xMax = d3.max(data, d => d.ci3stdev.high);

        const niceTicks = d3.ticks(xMin, xMax, 10);
        const step = niceTicks[1] - niceTicks[0];
        const domainStart = (query as AggregateQuery).accumulator.alwaysNonNegative ? Math.max(0, niceTicks[0] - step) : (niceTicks[0] - step);
        const domainEnd = niceTicks[niceTicks.length - 1] + step;

        if (node.domainStart > domainStart) node.domainStart = domainStart;
        if (node.domainEnd < domainEnd) node.domainEnd = domainEnd;

        const xScale = d3.scaleLinear().domain([node.domainStart, node.domainEnd])
            .range([labelWidth, width - VC.padding])
            .clamp(true)
        const yScale = d3.scaleBand().domain(util.srange(data.length))
            .range([VC.horizontalBars.axis.height,
            height - VC.horizontalBars.axis.height])
            .padding(0.1);

        this.yScale = yScale;

        const majorTickLines = d3.axisTop(xScale).tickSize(-(height - 2 * VC.horizontalBars.axis.height));

        selectOrAppend(visG, 'g', '.sub.axis')
            .style('opacity', .2)
            .attr('transform', translate(0, VC.horizontalBars.axis.height))
            .transition()
            .call(majorTickLines as any)
            .selectAll('text')
            .style('display', 'none')

        const topAxis = d3.axisTop(xScale).tickFormat(d3.format('~s'));

        selectOrAppend(visG, 'g', '.x.axis.top')
            .attr('transform', translate(0, VC.horizontalBars.axis.height))
            .transition()
            .call(topAxis as any)

        const eventBoxes = visG.selectAll('rect.event-box')
            .data(data, (d: any) => d.id);

        let enter = eventBoxes.enter().append('rect').attr('class', 'event-box variable1');

        this.eventBoxes = eventBoxes.merge(enter)
            .attr('height', yScale.bandwidth())
            .attr('width', width)
            .attr('class', 'event-box variable1')
            .attr('transform', (d, i) => translate(0, yScale(i + '')))
            .style('pointer-events', 'none')

        eventBoxes.exit().remove();

        let labels = visG
            .selectAll('text.label')
            .data(data, (d: any) => d.id);

        enter = labels.enter().append('text').attr('class', 'label variable1')
            .style('text-anchor', 'end')
            .attr('font-size', '.8rem')
            .attr('dy', '.8rem')
            .style('user-select', 'none')

        this.labels = labels.merge(enter)
            .attr('transform', (d, i) => translate(labelWidth - VC.padding, yScale(i + '')))
            .text((d, i) => `${d.keys.list[0].valueString()}`)
            .on('mouseenter', (d, i) => {
                const clientRect = nativeSvg.getBoundingClientRect();
                const parentRect = nativeSvg.parentElement.getBoundingClientRect();

                this.tooltip.show(
                    clientRect.left - parentRect.left + xScale(d.ci3stdev.center),
                    clientRect.top - parentRect.top + yScale(i + ''),
                    HorizontalBarsTooltipComponent,
                    d
                );

                if([SGT.Point, SGT.Range, SGT.Comparative].includes(this.safeguardType))
                {
                    let ele = d3.select(this.eventBoxes.nodes()[i]);
                    ele.classed('highlighted', true)
                }
            })
            .on('mouseleave', (d, i) => {
                this.tooltip.hide();
                if([SGT.Point, SGT.Range, SGT.Comparative].includes(this.safeguardType))
                {
                    if((!this.variable1 || this.variable1.fieldGroupedValue.hash
                        !== d.keys.list[0].hash) &&
                        (!this.variable2 || this.variable2.fieldGroupedValue.hash
                        !== d.keys.list[0].hash)) {
                        let ele = d3.select(this.eventBoxes.nodes()[i]);
                        ele.classed('highlighted', false)
                    }
                }
            })
            .on('click', (d, i) => {
                if([SGT.Point, SGT.Range, SGT.Comparative].includes(this.safeguardType))
                {
                    let variable = new SingleVariable(d.keys.list[0]);
                    if(this.variable2 && variable.fieldGroupedValue.hash === this.variable2.fieldGroupedValue.hash)
                        return;
                    this.variable1 = variable;
                    this.updateHighlight();

                    this.vis.variableSelected.emit({variable: variable});

                    if(this.safeguardType === SGT.Point) {
                        this.vis.constantSelected.emit(d.ci3stdev.center);
                        this.constantUserChanged(d.ci3stdev.center);
                    }
                }
            })
            .on('contextmenu', (d, i) => {
                if(this.safeguardType != SGT.Comparative) return;
                d3.event.preventDefault();

                let variable = new SingleVariable(d.keys.list[0]);

                if(this.variable1 && variable.fieldGroupedValue.hash === this.variable1.fieldGroupedValue.hash)
                    return;
                this.variable2 = variable;
                this.updateHighlight();

                this.vis.variableSelected.emit({
                    variable: variable,
                    secondary: true});
            })

        labels.exit().remove();

        let ranks = visG
            .selectAll('text.rank')
            .data(data, (d: any) => d.id);

        enter = ranks.enter().append('text').attr('class', 'rank variable1')
            .attr('font-size', '.8rem')
            .attr('dy', '.8rem')
            .style('opacity', 0.5)
            .style('user-select', 'none')

        this.ranks = ranks.merge(enter)
            .attr('transform', (d, i) => translate(0, yScale(i + '')))
            .text((d, i) => `${i + 1}`)

        ranks.exit().remove();

        const labelLines = visG.selectAll('line.label').data(data, (d: any) => d.id);

        enter = labelLines.enter().append('line').attr('class', 'label')
            .style('stroke', 'black')
            .style('opacity', 0.2);

        labelLines.merge(enter)
            .attr('x1', xScale.range()[0])
            .attr('x2', xScale.range()[1])
            .attr('y1', (d, i) => yScale(i + '') + yScale.bandwidth() / 2)
            .attr('y2', (d, i) => yScale(i + '') + yScale.bandwidth() / 2)

        labelLines.exit().remove();

        const leftBars = visG
            .selectAll('rect.left.bar')
            .data(data, (d: any) => d.id);

        enter = leftBars
            .enter().append('rect').attr('class', 'left bar')

        leftBars.merge(enter)
            .attr('height', yScale.bandwidth())
            .attr('width', d => xScale(d.ci3stdev.center) - xScale(d.ci3stdev.low))
            .attr('transform', (d, i) => translate(xScale(d.ci3stdev.low), yScale(i + '')))
            .attr('fill', this.gradient.leftUrl())

        leftBars.exit().remove();

        const rightBars = visG
            .selectAll('rect.right.bar')
            .data(data, (d: any) => d.id);

        enter = rightBars
            .enter().append('rect').attr('class', 'right bar')

        rightBars.merge(enter)
            .attr('height', yScale.bandwidth())
            .attr('width', d => xScale(d.ci3stdev.high) - xScale(d.ci3stdev.center))
            .attr('transform', (d, i) => translate(xScale(d.ci3stdev.center), yScale(i + '')))
            .attr('fill', this.gradient.rightUrl())

        rightBars.exit().remove();

        const centerLines = visG
            .selectAll('line.center')
            .data(data, (d: any) => d.id);

        enter = centerLines
            .enter().append('line').attr('class', 'center')

        centerLines.merge(enter)
            .attr('x1', (d, i) => xScale(d.ci3stdev.center))
            .attr('y1', (d, i) => yScale(i + ''))
            .attr('x2', (d, i) => xScale(d.ci3stdev.center))
            .attr('y2', (d, i) => yScale(i + '') + yScale.bandwidth())
            .style('stroke-width', done ? 2 : 1)
            .style('stroke', 'black')
            .style('shape-rendering', 'crispEdges')

        centerLines.exit().remove();

        if (done) {
            const circles = visG.selectAll('circle')
                .data(data, (d: any) => d.id);

            enter = circles.enter().append('circle')
                .attr('r', VC.horizontalBars.circleRadius)
                .attr('fill', 'steelblue')

            circles.merge(enter)
                .attr('cx', d => xScale(d.ci3stdev.center))
                .attr('cy', (d, i) => yScale(i + '') + yScale.bandwidth() / 2);

            circles.exit().remove();
        }
        else {
            visG.selectAll('circle')
                .remove();
        }

        const bottomAxis = d3.axisBottom(xScale).tickFormat(d3.format('~s'));

        selectOrAppend(visG, 'g', '.x.axis.bottom')
            .attr('transform', translate(0, height - VC.horizontalBars.axis.height))
            .transition()
            .call(bottomAxis as any)

        this.variableHighlight =
            selectOrAppend(visG, 'rect', '.variable1.highlighted')
            .attr('width', labelWidth)
            .attr('height', height - VC.horizontalBars.axis.height * 2)
            .attr('transform', translate(0, VC.horizontalBars.height))
            .attr('display', 'none')
            .style('pointer-events', 'none')

        this.variableHighlight2 =
            selectOrAppend(visG, 'rect', '.variable2.highlighted')
            .attr('width', labelWidth)
            .attr('height', height - VC.horizontalBars.axis.height * 2)
            .attr('transform', translate(0, VC.horizontalBars.height))
            .attr('display', 'none')
            .style('pointer-events', 'none')

        this.constantHighlight = selectOrAppend(visG, 'g', 'constant-highlight-wrapper')
            .attr('class', 'constant-highlight-wrapper')
            .style('opacity', 0)

        let selection = this.constantHighlight
            .selectAll('rect.constant.highlighted')
            .data([0, height - VC.horizontalBars.axis.height]);

        let enter2 = selection
            .enter()
            .append('rect')
            .attr('class', 'constant highlighted')
            .attr('width', width - labelWidth + VC.padding)
            .attr('height', VC.horizontalBars.axis.height)
            .attr('transform', d => translate(labelWidth - VC.padding, d))
            .on('click', (d, i) => {
                let x = xScale.invert(d3.event.offsetX);
                let step = d3.tickStep(xScale.domain()[0], xScale.domain()[1], 10) / 10;

                this.vis.constantSelected.emit(Math.round(x / step) * step);
            })
            .style('pointer-events', 'none')

        this.flexBrush.on('brush', () => {
            if(this.safeguardType === SGT.Point && this.variableType === VT.Value) {
                let sel = d3.event.selection;
                let center = (sel[0] + sel[1]) / 2;
                this.vis.constantSelected.emit(new PointValueConstant(this.xScale.invert(center)));
            }
        })

        if(this.variableType == VT.Value) {
            this.flexBrush.snap = null;
            this.flexBrush.render([[labelWidth, VC.horizontalBars.axis.height],
                [width - VC.padding, height - VC.horizontalBars.axis.height]]);
        }
        else {
            let start = VC.horizontalBars.axis.height;
            let step = VC.horizontalBars.height;

            this.flexBrush.snap = d => {
                return Math.round((d - start) / step) * step + start;
            };

            this.flexBrush.render([[0, VC.horizontalBars.axis.height],
                [width, height - VC.horizontalBars.axis.height]]);
        }

        if(this.constant) {
            if(this.safeguardType === SGT.Point) {
                let center = xScale(this.constant as number);
                this.flexBrush.move(center);
            }
            else if(this.safeguardType === SGT.Range) {
                // this.brushG.call(this.brush.move, (this.constant as [number, number]).map(this.xScale))
            }
        }
        else {
            if(this.safeguardType === SGT.Point) {
                let center = (this.width - this.labelWidth) / 2 + this.labelWidth;
                this.flexBrush.move(center);
            }
        }

        this.labelWidth = labelWidth;
        this.width = width;
        this.xScale = xScale;

        this.updateHighlight();
    }

    highlight(highlighted: number) {
        this.variableHighlight.attr('display', 'none')
        this.variableHighlight2.attr('display', 'none')
        this.constantHighlight.style('opacity', 0)

        if(highlighted == 1) {
            this.variableHighlight.attr('display', 'inline')
        }
        else if(highlighted == 2) {

        }
        else if(highlighted == 3) {
            // this.constantHighlight.style('opacity', 1)
        }
        else if(highlighted == 4) {
            this.variableHighlight2.attr('display', 'inline')
        }
    }

    constant: ConstantTrait;

    safeguardType: SGT;
    setSafeguardType(st: SGT) {
        this.safeguardType = st;

        this.variable1 = null;
        this.variable2 = null;
        this.constant = null;
        this.updateHighlight();

        if(st == SGT.None) {
            this.labels.style('cursor', 'auto');
            this.flexBrush.hide();
        }
        else if(st == SGT.Point) {
            this.labels.style('cursor', 'pointer');

            this.flexBrush.show();
            let center = (this.width - this.labelWidth) / 2 + this.labelWidth;
            this.flexBrush.move(center);
        }
        else if(st === SGT.Range) {
            this.labels.style('cursor', 'pointer');

            this.flexBrush.show();
        }
        else if(st === SGT.Comparative) {
            this.labels.style('cursor', 'pointer');

            this.flexBrush.hide();
        }
    }

    variableType: VT;
    setVariableType(vt: VT) {
        this.variableType = vt;

        if(vt == VT.Value) {
            this.flexBrush.setDirection(FlexBrushDirection.X);
        }
        else if(vt === VT.Rank) {
            this.flexBrush.setDirection(FlexBrushDirection.Y);
        }
    }

    updateHighlight() {
        this.eventBoxes
            .classed('highlighted', false)
            .filter((d, i) =>
                this.variable1 && this.variable1.fieldGroupedValue.hash === d.keys.list[0].hash ||
                this.variable2 && this.variable2.fieldGroupedValue.hash === d.keys.list[0].hash
                )
            .classed('highlighted', true)

        this.labels
            .classed('text-highlighted', false)
            .filter((d, i) =>
                this.variable1 && this.variable1.fieldGroupedValue.hash === d.keys.list[0].hash ||
                this.variable2 && this.variable2.fieldGroupedValue.hash === d.keys.list[0].hash
            )
            .classed('text-highlighted', true)

        this.eventBoxes
            .classed('variable2', false)
            .filter((d, i) => this.variable2 && this.variable2.fieldGroupedValue.hash === d.keys.list[0].hash)
            .classed('variable2', true)

        this.labels
            .classed('variable2', false)
            .filter((d, i) => this.variable2 && this.variable2.fieldGroupedValue.hash === d.keys.list[0].hash)
            .classed('variable2', true)
    }

    /* Invokes brush's event chain */
    constantUserChanged(constant: ConstantTrait, $event) {
        this.constant = constant;

        if(this.safeguardType === SGT.Point && this.variableType === VT.Value) {
            let center = this.xScale((constant as PointValueConstant).value);
            this.flexBrush.move(center);
        }
        else if(this.safeguardType === SGT.Range) {
            // this.brushG.call(this.brush.move, (constant as [number, number]).map(this.xScale))
        }
    }
}

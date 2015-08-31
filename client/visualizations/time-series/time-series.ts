'use strict';

import { List } from 'immutable';
import * as React from 'react/addons';
import * as d3 from 'd3';
import * as numeral from 'numeral';
import { $, Executor, Expression, Dataset, Datum, TimeRange, TimeBucketAction, ChainExpression } from 'plywood';
import { listsEqual } from '../../utils/general';
import { Stage, Essence, Splits, SplitCombine, Filter, Dimension, Measure, DataSource, Clicker, VisualizationProps, Resolve } from "../../models/index";
import { ChartLine } from '../../components/chart-line/chart-line';
import { TimeAxis } from '../../components/time-axis/time-axis';
import { VerticalAxis } from '../../components/vertical-axis/vertical-axis';
import { GridLines } from '../../components/grid-lines/grid-lines';
import { Highlighter } from '../../components/highlighter/highlighter';

const H_PADDING = 10;
const TITLE_TEXT_LEFT = 6;
const TITLE_TEXT_TOP = 23;
const TEXT_SPACER = 36;
const X_AXIS_HEIGHT = 30;
const Y_AXIS_WIDTH = 60;
const GRAPH_HEIGHT = 120;
const MAX_GRAPH_WIDTH = 2000;

function midpoint(timeRange: TimeRange): Date {
  return new Date((timeRange.start.valueOf() + timeRange.end.valueOf()) / 2);
}

function getTimeExtent(dataset: Dataset): [Date, Date] {
  var extentData: Date[] = [];
  var lastSplitDatasets: Dataset[] = [dataset.data[0]['Split']];

  // ToDo: flatten / map

  for (var lastSplitDataset of lastSplitDatasets) {
    var lastSplitData = lastSplitDataset.data;
    if (!lastSplitData.length) continue;
    extentData.push(
      lastSplitData[0]['Segment'].start,
      lastSplitData[lastSplitData.length - 1]['Segment'].end
    );
  }

  if (!extentData.length) return null;
  return d3.extent(extentData);
}

interface TimeSeriesState {
  dataset?: Dataset;
  dragStart?: number;
}

export class TimeSeries extends React.Component<VisualizationProps, TimeSeriesState> {
  static id = 'time-series';
  static title = 'Time Series';
  static handleCircumstance(dataSource: DataSource, splits: Splits): Resolve {
    if (splits.length() !== 1) return Resolve.MANUAL;
    var lastSplit = splits.last();
    var splitDimension = lastSplit.getDimension(dataSource);
    return splitDimension.type === 'TIME' ? Resolve.READY : Resolve.MANUAL;
  }

  public mounted: boolean;

  constructor() {
    super();
    this.state = {
      dataset: null,
      dragStart: null
    };
  }

  fetchData(essence: Essence): void {
    var { filter, splits, dataSource } = essence;
    var measures = essence.getMeasures();

    var $main = $('main');

    var query: any = $()
      .apply('main', $main.filter(filter.toExpression()));

    measures.forEach((measure) => {
      query = query.apply(measure.name, measure.expression);
    });

    var splitsSize = splits.length();
    splits.forEach((split, i) => {
      var isLast = i === splitsSize - 1;
      var subQuery = $main.split(split.toSplitExpression(), 'Segment');

      measures.forEach((measure) => {
        subQuery = subQuery.apply(measure.name, measure.expression);
      });
      if (isLast) {
        subQuery = subQuery.sort($('Segment'), 'ascending');
      } else {
        subQuery = subQuery.sort($(measures.first().name), 'descending').limit(5);
      }

      query = query.apply('Split', subQuery);
    });

    dataSource.executor(query).then((dataset) => {
      if (!this.mounted) return;
      this.setState({ dataset });
    });
  }

  componentDidMount() {
    this.mounted = true;
    var { essence } = this.props;
    this.fetchData(essence);
  }

  componentWillReceiveProps(nextProps: VisualizationProps) {
    var { essence } = this.props;
    var nextEssence = nextProps.essence;
    if (essence.differentOn(nextEssence, 'filter', 'splits', 'selectedMeasures')) {
      this.fetchData(nextEssence);
    }
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  onMouseDown(e: MouseEvent) {
    var myDOM = React.findDOMNode(this);
    var dragStart = e.clientX - (myDOM.getBoundingClientRect().left + H_PADDING);
    this.setState({ dragStart });
  }

  onHighlightEnd() {
    this.setState({ dragStart: null });
  }

  render() {
    var { clicker, essence, stage } = this.props;
    var { dataset, dragStart } = this.state;
    var { splits } = essence;

    var numberOfColumns = Math.ceil(stage.width / MAX_GRAPH_WIDTH);

    var measureGraphs: Array<React.ReactElement<any>> = null;
    var bottomAxes: Array<React.ReactElement<any>> = null;

    if (dataset && splits.length()) {
      var extentX = getTimeExtent(dataset);
      // if (!extentX)

      var myDatum: Datum = dataset.data[0];
      var myDataset: Dataset = myDatum['Split'];

      var getX = (d: Datum) => midpoint(d['Segment']);

      var parentWidth = stage.width - H_PADDING * 2;
      var svgStage = new Stage({
        x: H_PADDING,
        y: 0,
        width: Math.floor(parentWidth / numberOfColumns),
        height: TEXT_SPACER + GRAPH_HEIGHT
      });

      var lineStage = svgStage.within({ top: TEXT_SPACER, right: Y_AXIS_WIDTH });
      var yAxisStage = svgStage.within({ top: TEXT_SPACER, left: lineStage.width });

      var scaleX = d3.time.scale()
        .domain(extentX)
        .range([0, lineStage.width]);

      var xTicks = scaleX.ticks();

      measureGraphs = essence.getMeasures().toArray().map((measure) => {
        var measureName = measure.name;
        var getY = (d: Datum) => d[measureName];
        var extentY = d3.extent(myDataset.data, getY);

        if (isNaN(extentY[0])) {
          return JSX(`
            <svg className="measure-graph" key={measure.name} width={svgStage.width} height={svgStage.height}>
              <text x={TITLE_TEXT_LEFT} y={TITLE_TEXT_TOP}>{measure.title + ': Loading'}</text>
            </svg>
          `);
        }

        extentY[0] = Math.min(extentY[0] * 1.1, 0);
        extentY[1] = Math.max(extentY[1] * 1.1, 0);

        var scaleY = d3.scale.linear()
          .domain(extentY)
          .range([lineStage.height, 0]);

        var yTicks = scaleY.ticks().filter((n: number, i: number) => n !== 0 && i % 2 === 0);

        return JSX(`
          <svg
            className="measure-graph"
            key={measureName}
            width={svgStage.width}
            height={svgStage.height}
            onMouseDown={this.onMouseDown.bind(this)}
          >
            <GridLines
              orientation="horizontal"
              scale={scaleY}
              ticks={yTicks}
              stage={lineStage}
            />
            <GridLines
              orientation="vertical"
              scale={scaleX}
              ticks={xTicks}
              stage={lineStage}
            />
            <ChartLine
              dataset={myDataset}
              getX={getX}
              getY={getY}
              scaleX={scaleX}
              scaleY={scaleY}
              stage={lineStage}
            />
            <VerticalAxis
              stage={yAxisStage}
              yTicks={yTicks}
              scaleY={scaleY}
            />
            <text x={TITLE_TEXT_LEFT} y={TITLE_TEXT_TOP}>
              {measure.title + ': ' + numeral(myDatum[measureName]).format(measure.format)}
            </text>
          </svg>
        `);
      });

      var xAxisStage = Stage.fromSize(svgStage.width, X_AXIS_HEIGHT);
      bottomAxes = [];
      for (var i = 0; i < numberOfColumns; i++) {
        bottomAxes.push(JSX(`
          <svg className="bottom-axis" key={'bottom-axis-' + i} width={xAxisStage.width} height={xAxisStage.height}>
            <TimeAxis stage={xAxisStage} xTicks={xTicks} scaleX={scaleX}/>
          </svg>
        `));
      }

      var highlighter: React.ReactElement<any> = null;
      if (dragStart !== null) {
        var timeSplit = splits.first(); // ToDo: fix this
        var timeBucketAction = <TimeBucketAction>timeSplit.bucketAction;
        highlighter = React.createElement(Highlighter, {
          clicker,
          scaleX,
          dragStart,
          duration: timeBucketAction.duration,
          timezone: timeBucketAction.timezone,
          onHighlightEnd: <Function>this.onHighlightEnd.bind(this)
        });
      }
    }

    var measureGraphsStyle = {
      maxHeight: stage.height - X_AXIS_HEIGHT
    };

    return JSX(`
      <div className="time-series">
        <div className="measure-graphs" style={measureGraphsStyle}>
          {measureGraphs}
        </div>
        {bottomAxes}
        {highlighter}
      </div>
    `);
  }
}
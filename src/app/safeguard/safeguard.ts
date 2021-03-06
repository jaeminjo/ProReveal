import { Operators } from "./operator";
import { ConstantTrait, ValueConstant, RankConstant, RangeConstant, NormalConstant, PowerLawConstant, LinearRegressionConstant } from "./constant";
import { VariableTrait, VariablePair, DistributiveVariable, CombinedVariablePair } from "./variable";
import { NormalDistribution } from "./normal";
import {
    ValueEstimator, RankEstimator, RangeEstimator, ComparativeEstimator,
    NormalEstimator, PowerLawEstimator, LinearRegressionEstimator, MinMaxValueEstimator, MinMaxRankValueEstimator, MinMaxComparativeEstimator
} from "./estimate";
import { ValidityTypes, Validity } from "./validity";
import { AggregateQuery } from "../data/query";

const ValueEstimate = new ValueEstimator().estimate;
const MinMaxValueEstimate = new MinMaxValueEstimator().estimate
const RankEstimate = new RankEstimator().estimate;
const MinMaxRankEstimate = new MinMaxRankValueEstimator().estimate;
const RangeEstimate = new RangeEstimator().estimate;
const MinMaxRangeEstimate = new RangeEstimator().estimate;
const ComparativeEstimate = new ComparativeEstimator().estimate;
const MinMaxComparativeEstimate = new MinMaxComparativeEstimator().estimate;
const PowerLawEstimate = new PowerLawEstimator().estimate;
const NormalEstimate = new NormalEstimator().estimate;
const LinearRegressionEstimate = new LinearRegressionEstimator().estimate;



export enum SafeguardTypes {
    None = "None",
    Value = "Value",
    Rank = "Rank",
    Range = "Range",
    Comparative = "Comparative",
    PowerLaw = "PowerLaw",
    Normal = "Normal",
    Linear = "Linear"
}

export const DistributiveSafeguardTypes = [SafeguardTypes.PowerLaw, SafeguardTypes.Normal, SafeguardTypes.Linear];

export class Safeguard {
    static normal = new NormalDistribution();
    createdAt: Date;
    validityType: ValidityTypes;
    history: Validity[] = [];
    lastUpdated: number;
    lastUpdatedAt: Date;

    constructor(
        public type: SafeguardTypes,
        public variable: VariableTrait,
        public operator: Operators,
        public constant: ConstantTrait,
        public query: AggregateQuery
    ) {
        this.createdAt = new Date();
        this.lastUpdatedAt = new Date();
        this.lastUpdated = +new Date();
    }

    validity(): Validity {
        throw new Error('validity() must be implemented');
    }

    toLog() {
        return {
            type: this.type,
            variable: this.variable.toLog(),
            constant: this.constant ? this.constant.toLog() : null,
            query: this.query.toLog(),
            validity: this.validity()
        };
    }
}

export abstract class DistributiveSafeguard extends Safeguard {
    updateConstant() { };
}

export class ValueSafeguard extends Safeguard {
    readonly validityType = ValidityTypes.PValue;

    constructor(public variable: VariableTrait,
        public operator: Operators,
        public constant: ConstantTrait,
        public query: AggregateQuery) {
        super(SafeguardTypes.Value, variable, operator, constant, query);
    }

    p() {
        return ValueEstimate(
            this.query,
            this.variable,
            this.operator,
            this.constant as ValueConstant);
    }

    t() {  // min or max
        return MinMaxValueEstimate(
            this.query,
            this.variable,
            this.operator,
            this.constant as ValueConstant);
    }

    validity() {
        if (this.query.approximator.estimatable) return this.p();
        return this.t();
    }
}

export class RankSafeguard extends Safeguard {
    readonly validityType = ValidityTypes.PValue;

    constructor(public variable: VariableTrait,
        public operator: Operators,
        public constant: ConstantTrait,
        public query: AggregateQuery) {
        super(SafeguardTypes.Rank, variable, operator, constant, query);
    }

    p() {
        return RankEstimate(
            this.query,
            this.variable,
            this.operator,
            this.constant as RankConstant);
    }

    t() {  // min or max
        return MinMaxRankEstimate(
            this.query,
            this.variable,
            this.operator,
            this.constant as RankConstant);
    }

    validity() {
        if (this.query.approximator.estimatable) return this.p();
        return this.t();
    }
}

export class RangeSafeguard extends Safeguard {
    readonly validityType = ValidityTypes.PValue;

    constructor(public variable: VariableTrait,
        public constant: ConstantTrait,
        public query: AggregateQuery) {
        super(SafeguardTypes.Range, variable, Operators.InRange, constant, query);
    }

    p() {
        return RangeEstimate(
            this.query,
            this.variable,
            this.operator,
            this.constant as RangeConstant);
    }

    t() {  // min or max
        return MinMaxRangeEstimate(
            this.query,
            this.variable,
            this.operator,
            this.constant as RangeConstant);
    }

    validity() {
        if (this.query.approximator.estimatable) return this.p();
        return this.t();
    }
}

export class ComparativeSafeguard extends Safeguard {
    readonly validityType = ValidityTypes.PValue;

    constructor(public variable: VariablePair | CombinedVariablePair,
        public operator: Operators,
        public query: AggregateQuery) {
        super(SafeguardTypes.Comparative, variable, operator, null, query);
    }

    p() {
        if (this.variable.isRank)
            throw new Error('Cannot estimate the p value for rank');

        return ComparativeEstimate(
            this.query,
            this.variable,
            this.operator);
    }

    t() {
        return MinMaxComparativeEstimate(this.query, this.variable, this.operator);
    }

    validity() {
        if (this.query.approximator.estimatable) return this.p();
        return this.t();
    }
}

export class PowerLawSafeguard extends DistributiveSafeguard {
    readonly validityType = ValidityTypes.Quality;

    constructor(public constant: ConstantTrait,
        public query: AggregateQuery) {
        super(SafeguardTypes.PowerLaw,
            new DistributiveVariable(),
            Operators.Follow,
            constant, query);
    }

    q() {
        return PowerLawEstimate(
            this.query,
            this.constant as PowerLawConstant
        );
    }

    validity() {
        return this.q();
    }

    updateConstant() {
        this.constant = PowerLawConstant.FitFromVisData(this.query.getRecentData());
    }
}

export class NormalSafeguard extends DistributiveSafeguard {
    readonly validityType = ValidityTypes.Quality;

    constructor(public constant: ConstantTrait,
        public query: AggregateQuery) {
        super(SafeguardTypes.Normal,
            new DistributiveVariable(),
            Operators.Follow,
            constant, query);
    }

    q() {
        return NormalEstimate(
            this.query,
            this.constant as NormalConstant);
    }

    validity() {
        return this.q();
    }

    updateConstant() {
        this.constant = NormalConstant.FitFromVisData(this.query.getRecentData());
    }
}

export class LinearSafeguard extends DistributiveSafeguard {
    readonly validityType = ValidityTypes.Error;

    constructor(public constant: ConstantTrait,
        public query: AggregateQuery) {
        super(SafeguardTypes.Linear,
            new DistributiveVariable(),
            Operators.Follow,
            constant, query);
    }

    e() {
        return LinearRegressionEstimate(
            this.query,
            this.constant as LinearRegressionConstant
        )
    }

    validity() {
        return this.e();
    }

    updateConstant() {
        this.constant = LinearRegressionConstant.FitFromVisData(this.query.getRecentData());
    }
}

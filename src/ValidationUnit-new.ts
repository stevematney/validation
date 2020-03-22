import validator from 'validator';
import { isUndefined, isNull } from 'lodash/lang';
import formatValidationMessage from './util/format-validation-message';

type DynamicObject = { [k: string]: any };
export interface ValidationRule {
  validationFunction: (
    value: string,
    allValues?: DynamicObject
  ) => boolean | Promise<boolean>;
  failureMessage: string;
  name: string;
  discrete: boolean;
  isAsync: boolean;
}

type BooleanValidationFunction = (
  value?: string,
  allValues?: DynamicObject
) => boolean;

type AsyncValidationFunction = (
  value?: string,
  allValues?: DynamicObject
) => Promise<boolean>;

interface BooleanValidationRule extends ValidationRule {
  validationFunction: BooleanValidationFunction;
}

const defaultValidationRule: BooleanValidationRule = {
  validationFunction: () => false,
  failureMessage: 'default validation message',
  name: 'Default Rule',
  discrete: false,
  isAsync: false
};

/* eslint-disable @typescript-eslint/camelcase */
// copied from https://github.com/validatorjs/validator.js/blob/master/src/lib/isCurrency.js
const defaultCurrencyOptions: validator.IsCurrencyOptions = {
  symbol: '$',
  require_symbol: false,
  allow_space_after_symbol: false,
  symbol_after_digits: false,
  allow_negatives: true,
  parens_for_negatives: false,
  negative_sign_before_digits: false,
  negative_sign_after_digits: false,
  allow_negative_sign_placeholder: false,
  thousands_separator: ',',
  decimal_separator: '.',
  allow_decimal: true,
  require_decimal: false,
  digits_after_decimal: [2],
  allow_space_after_digits: false
};

const defaultFqdnOptions: validator.IsFQDNOptions = {
  require_tld: true,
  allow_underscores: false,
  allow_trailing_dot: false
};
/* eslint-enable @typescript-eslint/camelcase */

interface ValidationResult {
  isValid: boolean;
  message: string;
}

interface ValidationState {
  isValid?: boolean;
  messages?: string[];
  waiting: boolean;
}

export default class ValidationUnit {
  rules: ValidationRule[];
  isValid?: boolean;
  value?: string;
  messages?: string[];
  waiting = false;
  constructor(...existingUnits: ValidationUnit[]) {
    const validationState = existingUnits
      .filter(unit => unit.isValid !== undefined || unit.messages !== undefined)
      .shift();
    this.isValid = validationState?.isValid;
    this.messages = validationState?.messages;

    const getDistinctRules = (
      finalRules: ValidationRule[],
      rule: ValidationRule
    ): ValidationRule[] => {
      const hasEquivalent = finalRules.some(
        existingRule => existingRule.name === rule.name
      );
      if (!rule.discrete && hasEquivalent) return finalRules;
      return [...finalRules, rule];
    };
    this.rules = existingUnits
      .reduce(
        (rules: ValidationRule[], unit: ValidationUnit) => [
          ...rules,
          ...unit.rules
        ],
        []
      )
      .reduce(getDistinctRules, []);
  }
  async runValidation(
    value: string,
    allValues: DynamicObject,
    name: string
  ): Promise<void> {
    if (this.waiting && this.value === value) return;
    this.waiting = true;

    return this.checkRules<Promise<void>>(
      value,
      allValues,
      name,
      async () => {
        const results = await Promise.all<ValidationResult>(
          this.rules.map(async rule => {
            const isValid = await rule.validationFunction(value, allValues);
            return {
              isValid,
              message:
                !isValid &&
                rule.failureMessage &&
                formatValidationMessage(rule.failureMessage, { name })
            };
          })
        );
        this.setValidity(results);
        this.waiting = false;
      },
      () => Promise.resolve(undefined)
    );
  }
  runValidationSync(
    value: string,
    allValues: DynamicObject,
    name: string
  ): void {
    this.checkRules<void>(
      value,
      allValues,
      name,
      () => {
        const results = this.rules
          .filter(rule => !rule.isAsync)
          .map(
            (rule: ValidationRule): ValidationResult => {
              const isValid = rule.validationFunction(
                value,
                allValues
              ) as boolean;
              return {
                isValid,
                message:
                  !isValid &&
                  rule.failureMessage &&
                  formatValidationMessage(rule.failureMessage, { name })
              };
            }
          );
        this.setValidity(results);
      },
      () => undefined
    );
  }

  initializeState(isValid: boolean, messages: string[]): ValidationUnit {
    this.isValid = isValid;
    this.messages = messages;
    return this;
  }

  getValidationState(): ValidationState {
    const { isValid, messages, waiting, value } = this;
    let actuallyIsValid =
      !this.shouldCheckValue(value as string) && value === undefined
        ? true
        : isValid;
    if (waiting) {
      actuallyIsValid = undefined;
    }
    return {
      waiting,
      isValid: actuallyIsValid,
      messages
    };
  }

  isValidatedBy(
    validationFunction: BooleanValidationFunction,
    failureMessage: string
  ): ValidationUnit {
    return this.setRequirement({
      validationFunction,
      failureMessage,
      name: failureMessage,
      discrete: true,
      isAsync: false
    });
  }
  removeIsValidatedBy(
    criteria: BooleanValidationFunction | string
  ): ValidationUnit {
    return this.removeCustomRule(criteria);
  }

  isEventuallyValidatedBy(
    validationFunction: AsyncValidationFunction,
    failureMessage: string
  ): ValidationUnit {
    return this.setRequirement({
      validationFunction,
      failureMessage,
      name: failureMessage,
      discrete: true,
      isAsync: true
    });
  }
  removeIsEventuallyValidatedBy(
    criteria: AsyncValidationFunction | string
  ): ValidationUnit {
    return this.removeCustomRule(criteria);
  }

  private isRequiredRule: ValidationRule = {
    ...defaultValidationRule,
    validationFunction: val => !!val,
    failureMessage: '{name} is required.',
    name: 'isRequired'
  };
  isRequired(failureMessage?: string): ValidationUnit {
    return this.setRequirement({
      ...this.isRequiredRule,
      failureMessage: failureMessage || this.isRequiredRule.failureMessage
    });
  }
  removeIsRequired(): ValidationUnit {
    return this.remove(this.isRequiredRule);
  }

  private isRequiredWhenName = 'isRequiredWhen';
  isRequiredWhen(
    shouldBeRequiredFunc: BooleanValidationFunction,
    failureMessage?: string
  ): ValidationUnit {
    return this.setRequirement({
      ...defaultValidationRule,
      validationFunction: (value, allValues) => {
        return (
          !shouldBeRequiredFunc(value, allValues) ||
          this.isRequiredRule.validationFunction(value, allValues)
        );
      },
      name: this.isRequiredWhenName,
      failureMessage: failureMessage || this.isRequiredRule.failureMessage
    });
  }
  removeIsRequiredWhen(): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: this.isRequiredWhenName
    });
  }

  equalsOther(
    other: string,
    failureMessage = '{name} must be equal to {other}.'
  ): ValidationUnit {
    return this.setRequirement({
      ...defaultValidationRule,
      validationFunction: (value, allValues) =>
        validator.equals(value, allValues && allValues[other]),
      failureMessage: formatValidationMessage(failureMessage, { other }),
      name: `equalsOther ${other}`
    });
  }
  removeEqualsOther(other: string): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: `equalsOther ${other}`
    });
  }

  containsRule: ValidationRule = {
    ...defaultValidationRule,
    failureMessage: '{name} must contain "{needle}."'
  };
  contains(needle: string, failureMessage?: string): ValidationUnit {
    return this.setRequirement({
      ...this.containsRule,
      validationFunction: (value: string) => validator.contains(value, needle),
      failureMessage: formatValidationMessage(
        failureMessage ?? this.containsRule.failureMessage,
        { needle }
      ),
      name: `contains ${needle}`
    });
  }
  removeContains(needle: string): ValidationUnit {
    return this.remove({
      ...this.containsRule,
      name: `contains ${needle}`
    });
  }

  equalsRule: ValidationRule = {
    ...defaultValidationRule,
    failureMessage: '{name} must equal "{comparison}."'
  };
  equals(comparison: string, failureMessage?: string): ValidationUnit {
    return this.setRequirement({
      ...this.equalsRule,
      validationFunction: val => validator.equals(val, comparison),
      failureMessage: formatValidationMessage(
        failureMessage ?? this.equalsRule.failureMessage,
        { comparison }
      ),
      name: `equals ${comparison}`
    });
  }
  removeEquals(comparison: string): ValidationUnit {
    return this.remove({
      ...this.equalsRule,
      name: `equals ${comparison}`
    });
  }

  isEmailRule: ValidationRule = {
    ...defaultValidationRule,
    name: 'isEmail',
    failureMessage: '{name} must be a valid email address.',
    validationFunction: val => validator.isEmail(val)
  };
  isEmail(failureMessage?: string): ValidationUnit {
    return this.setRequirement({
      ...this.isEmailRule,
      failureMessage: failureMessage ?? this.isEmailRule.failureMessage
    });
  }
  removeIsEmail(): ValidationUnit {
    return this.remove(this.isEmailRule);
  }

  isBefore(
    date: string,
    failureMessage = '{name} must be a date before {date}.'
  ): ValidationUnit {
    return this.setRequirement({
      ...defaultValidationRule,
      name: `isBefore ${date}`,
      failureMessage: formatValidationMessage(failureMessage, { date }),
      validationFunction: val => validator.isBefore(val, date)
    });
  }
  removeIsBefore(date: string): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: `isBefore ${date}`
    });
  }

  isAfter(
    date: string,
    failureMessage = '{name} must be a date after {date}.'
  ): ValidationUnit {
    return this.setRequirement({
      ...defaultValidationRule,
      name: `isAfter ${date}`,
      failureMessage: formatValidationMessage(failureMessage, { date }),
      validationFunction: val => validator.isAfter(val, date)
    });
  }
  removeIsAfter(date: string): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: `isAfter ${date}`
    });
  }

  isAlpha(
    failureMessage = '{name} must use only alphabetical characters.'
  ): ValidationUnit {
    return this.setRequirement({
      ...defaultValidationRule,
      name: `isAlpha`,
      failureMessage,
      validationFunction: val => validator.isAlpha(val)
    });
  }
  removeIsAlpha(): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: `isAlpha`
    });
  }

  isAlphanumeric(
    failureMessage = '{name} must use only alphanumeric characters.'
  ): ValidationUnit {
    return this.setRequirement({
      ...defaultValidationRule,
      name: `isAlphanumeric`,
      failureMessage,
      validationFunction: val => validator.isAlphanumeric(val)
    });
  }
  removeIsAlphanumeric(): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: `isAlphanumeric`
    });
  }

  isAscii(
    failureMessage = '{name} must use only ASCII characters.'
  ): ValidationUnit {
    return this.setRequirement({
      ...defaultValidationRule,
      name: `isAscii`,
      failureMessage,
      validationFunction: val => validator.isAscii(val)
    });
  }
  removeIsAscii(): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: `isAscii`
    });
  }

  isBase64(failureMessage = '{name} must be base64 encoded.'): ValidationUnit {
    return this.setRequirement({
      ...defaultValidationRule,
      name: `isBase64`,
      failureMessage,
      validationFunction: val => validator.isBase64(val)
    });
  }
  removeIsBase64(): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: `isBase64`
    });
  }

  isBoolean(
    failureMessage = '{name} must be a boolean value.'
  ): ValidationUnit {
    return this.setRequirement({
      ...defaultValidationRule,
      name: `isBoolean`,
      failureMessage,
      validationFunction: val => validator.isBoolean(val)
    });
  }
  removeIsBoolean(): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: `isBoolean`
    });
  }

  isByteLength(
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
    failureMessage = '{name} must have a minimum byte length of {min}.'
  ): ValidationUnit {
    return this.setRequirement({
      ...defaultValidationRule,
      name: `isByteLength ${min} ${max}`,
      failureMessage: formatValidationMessage(failureMessage, { min, max }),
      validationFunction: val => validator.isByteLength(val, { min, max })
    });
  }
  removeIsByteLength(min = 0, max = Number.MAX_SAFE_INTEGER): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: `isByteLength ${min} ${max}`
    });
  }

  private creditCardRule: ValidationRule = {
    ...defaultValidationRule,
    name: `isCreditCard`,
    validationFunction: val => validator.isCreditCard(val)
  };
  isCreditCard(
    failureMessage = '{name} must be a credit card number.'
  ): ValidationUnit {
    return this.setRequirement({ ...this.creditCardRule, failureMessage });
  }
  removeisCreditCard(): ValidationUnit {
    return this.remove(this.creditCardRule);
  }

  /* eslint-disable @typescript-eslint/camelcase */
  private getCurrencyFormat(options: validator.IsCurrencyOptions): string {
    const symbol = options.require_symbol ? options.symbol : '';
    const symbolStart = options.symbol_after_digits ? '' : symbol;
    const symbolEnd = options.symbol_after_digits ? symbol : '';
    const { thousands_separator, decimal_separator } = options;
    const format = `${symbolStart}1${thousands_separator}000${decimal_separator}00${symbolEnd}`;
    return format;
  }
  /* eslint-enable @typescript-eslint/camelcase */

  private currencyRule = {
    ...defaultValidationRule,
    name: `isCurrency`
  };
  isCurrency(
    options: validator.IsCurrencyOptions = defaultCurrencyOptions,
    failureMessage = '{name} must be in the format "{format}".'
  ): ValidationUnit {
    const computedOptions = { ...defaultCurrencyOptions, ...options };
    const format = this.getCurrencyFormat(computedOptions);
    const messageWithFormat = formatValidationMessage(failureMessage, {
      format,
      ...computedOptions
    });
    return this.setRequirement({
      ...this.currencyRule,
      failureMessage: messageWithFormat,
      validationFunction: val => validator.isCurrency(val, options)
    });
  }
  removeIsCurrency(): ValidationUnit {
    return this.remove(this.currencyRule);
  }

  private dateRule: ValidationRule = {
    ...defaultValidationRule,
    name: `isDate`,
    validationFunction: val => validator.isCreditCard(val)
  };
  isDate(failureMessage = '{name} must be a date.'): ValidationUnit {
    return this.setRequirement({
      ...this.dateRule,
      failureMessage
    });
  }
  removeIsDate(): ValidationUnit {
    return this.remove(this.dateRule);
  }

  private decimalRule: ValidationRule = {
    ...defaultValidationRule,
    name: `isDate`,
    validationFunction: val => validator.isDecimal(val)
  };
  isDecimal(failureMessage = '{name} must be a date.'): ValidationUnit {
    return this.setRequirement({
      ...this.decimalRule,
      failureMessage
    });
  }
  removeIsDecimal(): ValidationUnit {
    return this.remove(this.decimalRule);
  }

  private divisibleRule: ValidationRule = {
    ...defaultValidationRule,
    name: `isDivisibleBy`
  };
  isDivisibleBy(
    divisor: number,
    failureMessage = '{name} must be divisible by {number}.'
  ): ValidationUnit {
    return this.setRequirement({
      ...this.divisibleRule,
      failureMessage: formatValidationMessage(failureMessage, divisor),
      validationFunction: val => validator.isDivisibleBy(val, divisor)
    });
  }
  removeIsDivisibleBy(): ValidationUnit {
    return this.remove(this.divisibleRule);
  }

  private fqdnRule: ValidationRule = {
    ...defaultValidationRule,
    name: `isDivisibleBy`
  };
  isFQDN(
    options = defaultFqdnOptions,
    failureMessage = '{name} must be a fully qualified domain name.'
  ): ValidationUnit {
    return this.setRequirement({
      ...this.divisibleRule,
      failureMessage,
      validationFunction: val => validator.isFQDN(val, options)
    });
  }
  removeIsFQDN(): ValidationUnit {
    return this.remove(this.fqdnRule);
  }

  private floatRule: ValidationRule = {
    ...defaultValidationRule,
    name: 'isFloat'
  };
  isFloat(
    options: validator.IsFloatOptions = {},
    failureMessage = '{name} must be a float.'
  ): ValidationUnit {
    return this.setRequirement({
      ...this.floatRule,
      validationFunction: val => validator.isFloat(val, options),
      failureMessage
    });
  }
  removeIsFloat(): ValidationUnit {
    return this.remove(this.floatRule);
  }

  private fullWidthRule: ValidationRule = {
    ...defaultValidationRule,
    name: 'isFullWidth',
    validationFunction: val => validator.isFullWidth(val)
  };
  isFullWidth(
    failureMessage = '{name} must contain fullwidth characters.'
  ): ValidationUnit {
    return this.setRequirement({
      ...this.fullWidthRule,
      failureMessage
    });
  }
  removeIsFullWidth(): ValidationUnit {
    return this.remove(this.fullWidthRule);
  }

  private halfWidthRule: ValidationRule = {
    ...defaultValidationRule,
    name: 'isHalfWidth',
    validationFunction: val => validator.isHalfWidth(val)
  };
  isHalfWidth(
    failureMessage = '{name} must contain halfwidth characters.'
  ): ValidationUnit {
    return this.setRequirement({
      ...this.halfWidthRule,
      failureMessage
    });
  }
  removeIsHalfWidth(): ValidationUnit {
    return this.remove(this.halfWidthRule);
  }

  private variableWidthRule: ValidationRule = {
    ...defaultValidationRule,
    name: 'ishalfWidth',
    validationFunction: val => validator.isVariableWidth(val)
  };
  isVariableWidth(
    failureMessage = '{name} must contain fullwidth and halfwidth ccharacters.'
  ): ValidationUnit {
    return this.setRequirement({
      ...this.variableWidthRule,
      failureMessage
    });
  }
  removeIsVariableWidth(): ValidationUnit {
    return this.remove(this.variableWidthRule);
  }

  private hexColorRule: ValidationRule = {
    ...defaultValidationRule,
    name: 'isHexColor',
    validationFunction: val => validator.isHexColor(val)
  };
  isHexColor(failureMessage = '{name} must be a hex color.'): ValidationUnit {
    return this.setRequirement({
      ...this.hexColorRule,
      failureMessage
    });
  }
  removeIsHexColor(): ValidationUnit {
    return this.remove(this.hexColorRule);
  }

  private hexadecimalRule: ValidationRule = {
    ...defaultValidationRule,
    name: 'isHexadecimal',
    validationFunction: val => validator.isHexadecimal(val)
  };
  isHexadecimal(
    failureMessage = '{name} must be a hexadecimal number.'
  ): ValidationUnit {
    return this.setRequirement({
      ...this.hexadecimalRule,
      failureMessage
    });
  }
  removeIsHexadecimal(): ValidationUnit {
    return this.remove(this.hexadecimalRule);
  }

  private ipRule: ValidationRule = {
    ...defaultValidationRule,
    name: 'isIP'
  };
  isIP(
    failureMessage = '{name} must be an IP address.',
    version = undefined
  ): ValidationUnit {
    return this.setRequirement({
      ...this.ipRule,
      validationFunction: val => validator.isIP(val, version),
      failureMessage
    });
  }
  removeIsIP(): ValidationUnit {
    return this.remove(this.ipRule);
  }

  private isbnRule: ValidationRule = {
    ...defaultValidationRule,
    name: 'isISBN'
  };
  isISBN(
    failureMessage = '{name} must be an ISBN.',
    version?: '10' | '13'
  ): ValidationUnit {
    return this.setRequirement({
      ...this.isbnRule,
      failureMessage,
      validationFunction: val => validator.isISBN(val, version)
    });
  }
  removeIsISBN(): ValidationUnit {
    return this.remove(this.isbnRule);
  }

  private isinRule: ValidationRule = {
    ...defaultValidationRule,
    name: 'isISIN',
    validationFunction: val => validator.isISIN(val)
  };
  isISIN(failureMessage = '{name} must be an ISIN.'): ValidationUnit {
    return this.setRequirement({
      ...this.isinRule,
      failureMessage
    });
  }
  removeIsISIN(): ValidationUnit {
    return this.remove(this.isinRule);
  }

  private iso8601Rule: ValidationRule = {
    ...defaultValidationRule,
    name: 'isISO8601',
    validationFunction: val => validator.isISO8601(val)
  };
  isISO8601(
    failureMessage = '{name} must be an ISO6801 date.'
  ): ValidationUnit {
    return this.setRequirement({
      ...this.iso8601Rule,
      failureMessage
    });
  }
  removeIsISO8601(): ValidationUnit {
    return this.remove(this.iso8601Rule);
  }

  isIn(
    values: any[],
    failureMessage = '{name} must be contained in {values}.'
  ): ValidationUnit {
    const stringValues = JSON.stringify(values);
    return this.setRequirement({
      ...defaultValidationRule,
      name: `isIn ${stringValues}`,
      validationFunction: val => validator.isIn(val, values),
      failureMessage: formatValidationMessage(failureMessage, {
        values: stringValues
      })
    });
  }
  removeIsIn(values: any[]): ValidationUnit {
    return this.remove({
      ...defaultValidationRule,
      name: `isIn ${JSON.stringify(values)}`
    });
  }

  private removeCustomRule(
    criteria: BooleanValidationFunction | AsyncValidationFunction | string
  ): ValidationUnit {
    if (criteria instanceof Function) {
      this.rules = this.rules.filter(
        rule => rule.validationFunction !== criteria
      );
      return this;
    }
    this.remove({
      ...defaultValidationRule,
      name: criteria
    });
    return this;
  }

  private setRequirement(newRule: ValidationRule): ValidationUnit {
    const matchingRules = this.rules
      .filter(rule => !rule.discrete)
      .filter(rule => rule.name === newRule.name);
    if (matchingRules.length && !newRule.discrete) return this;

    this.rules.push(newRule);
    return this;
  }
  private checkRules<T>(
    value: string,
    allValues: DynamicObject,
    name: string,
    checkingFunction: (
      value: string,
      allValues: DynamicObject,
      name: string
    ) => T,
    earlyReturnFunction: () => T
  ): T {
    this.value = value;
    this.isValid = undefined;
    this.messages = [];

    if (!this.shouldCheckValue(value)) {
      this.isValid = true;
      return earlyReturnFunction();
    }

    return checkingFunction(value, allValues, name);
  }
  private setValidity(results: ValidationResult[]): void {
    this.messages = results
      .map(result => result.message)
      .filter(message => message);
    this.isValid = results.every(result => result.isValid);
  }
  private remove(removedRule: ValidationRule): ValidationUnit {
    this.rules = this.rules.filter(rule => rule.name !== removedRule.name);
    return this;
  }
  private shouldCheckValue(value: string): boolean {
    const hasRequiredRules = this.rules.some(x =>
      x.name.includes('isRequired')
    );
    const isCheckable =
      !isUndefined(value) && !isNull(value) && !!value.toString();
    return hasRequiredRules || isCheckable;
  }
}

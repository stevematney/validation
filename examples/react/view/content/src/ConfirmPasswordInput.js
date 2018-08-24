import React from 'react';
import ValidatedInput from './ValidatedInput';
import inputProps from './input-props';
import valour from 'valour';
import PropTypes from 'prop-types';

export default class ConfirmPasswordInput extends React.Component {
  static propTypes = {
    ...inputProps,
    matches: PropTypes.string.isRequired
  }
  constructor() {
    super();
    this.state = {};
    this.getValidation = this.getValidation.bind(this);
  }

  getSanitizedValue(val) {
    return val.trim();
  }

  getValidation() {
    return valour.rule.equalsOther(this.props.matches);
  }

  render() {
    const {getValidation, getSanitizedValue} = this;
    let props = {...this.props, getValidation, getSanitizedValue};
    return <ValidatedInput { ...props } type='password' />;
  }
}

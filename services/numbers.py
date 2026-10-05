import math


def json_number(value, whole_as_int=True):
    """float(value) for JSON, or None for NaN/inf (conviction is inf when confidence is 1)."""
    number = float(value)
    if math.isnan(number) or math.isinf(number):
        return None
    if whole_as_int and number.is_integer():
        return int(number)
    return number

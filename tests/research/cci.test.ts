import { describe, expect, it } from 'vitest';
import { ADVERSE, CCI_DAILY_VARS, category, climateOf, dailyCci, humidex, slope, sunRating, tcRating } from '../../src/research/cci.mjs';

describe('Camping Climate Index (Ma 2021, eq. 3, Tables 3 and 4)', () => {
  it('computes thermal comfort as humidex from mean temperature and dew point (Masterton and Richardson 1979)', () => {
    expect(humidex(25, 20)).toBeCloseTo(32.6, 1);
    expect(humidex(30, 10)).toBeCloseTo(31.28, 2);
  });

  it('rates thermal comfort and sunshine by Table 3, ideal at 28–34 °C and 14 h of sun', () => {
    expect([45, 42, 36, 34, 30, 28, 25, 21, 17, 13, 9, 5, 3, 1].map(tcRating)).toEqual([0, 0, 7, 7, 10, 10, 9, 8, 7, 6, 5, 4, 3, 0]);
    expect([15, 14, 13, 10, 7, 5, 3].map(sunRating)).toEqual([10, 10, 9, 8, 4, 2, 0]);
  });

  it('weights comfort and sunshine half each and caps an adverse day at 3: Tmin < 8 °C, Tmax > 34 °C, rain > 10 mm or wind > 23 km/h', () => {
    const fine = { tmean: 25, dew: 20, sunHours: 12, tmin: 18, tmax: 30, rain: 0, wind: 10 };
    expect(dailyCci(fine)).toBe(9.5);
    expect(ADVERSE).toEqual({ tminBelow: 8, tmaxAbove: 34, rainAbove: 10, windAbove: 23 });
    expect(dailyCci({ ...fine, tmax: 34.5 })).toBe(3);
    expect(dailyCci({ ...fine, tmin: 7.9 })).toBe(3);
    expect(dailyCci({ ...fine, rain: 11 })).toBe(3);
    expect(dailyCci({ ...fine, wind: 24 })).toBe(3);
    expect(dailyCci({ ...fine, sunHours: 2, tmax: 35 })).toBe(3);
    expect(dailyCci({ ...fine, tmean: 5, dew: 0, sunHours: 2, tmin: 1, tmax: 9 })).toBe(1.5);
    expect(dailyCci({ ...fine, dew: Number.NaN })).toBeNull();
  });

  it('names the categories of Table 4', () => {
    expect([9, 7, 6, 5, 4, 3, 2, null].map(category)).toEqual(['optimal', 'optimal', 'good', 'good', 'acceptable', 'acceptable', 'unfavourable', 'unknown']);
  });

  it('counts optimal days per year, hot days above 34 °C, and the trend of optimal days across the years measured', () => {
    const time: string[] = [];
    const days: Record<string, number[]> = { temperature_2m_mean: [], dew_point_2m_mean: [], sunshine_duration: [], temperature_2m_min: [], temperature_2m_max: [], precipitation_sum: [], wind_speed_10m_mean: [] };
    for (const year of [2021, 2022, 2023]) {
      for (let i = 0; i < 365; i++) {
        const date = new Date(Date.UTC(year, 0, 1 + i)).toISOString().slice(0, 10);
        time.push(date);
        const optimal = i < 100 + (year - 2021) * 10;
        const hot = i >= 360;
        days.temperature_2m_mean.push(optimal ? 25 : 12);
        days.dew_point_2m_mean.push(optimal ? 20 : 8);
        days.sunshine_duration.push((optimal ? 12 : 5) * 3600);
        days.temperature_2m_min.push(15);
        days.temperature_2m_max.push(hot ? 36 : 28);
        days.precipitation_sum.push(0);
        days.wind_speed_10m_mean.push(10);
      }
    }
    const climate = climateOf({ time, ...days })!;
    expect(climate.cci).toMatchObject({ optimalDays: 110, hotDays: 5, optimalTrend: 10, years: 3 });
    expect(climate.cci.perYear.map((y: { optimal: number }) => y.optimal)).toEqual([100, 110, 120]);
    expect(slope([[1, 2]])).toBeNull();
  });

  it('asks Open-Meteo for exactly the daily variables the index needs', () => {
    expect(CCI_DAILY_VARS.split(',')).toEqual(['temperature_2m_mean', 'temperature_2m_max', 'temperature_2m_min', 'dew_point_2m_mean', 'sunshine_duration', 'precipitation_sum', 'wind_speed_10m_mean']);
  });
});

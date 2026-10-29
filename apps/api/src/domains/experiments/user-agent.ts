import deviceData from '@api/domains/experiments/device-rules.json';

export interface DeviceMetadata {
  model: string;
  type: 'Tablet' | 'Mobile' | 'PC';
}

const patterns = deviceData.rules.map((rule) => ({
  expression: new RegExp(rule.regex, rule.flags ?? ''),
  replacement: rule.replacement,
}));

export function parseDeviceMetadata(userAgent: string | undefined): DeviceMetadata | null {
  if (userAgent === undefined) return null;
  const lower = userAgent.toLowerCase();
  const type = ['tablet', 'ipad'].some((part) => lower.includes(part))
    ? 'Tablet'
    : ['mobile', 'mobi', 'android', 'iphone', 'ios', 'windows phone'].some((part) => lower.includes(part))
      ? 'Mobile'
      : 'PC';
  for (const { expression, replacement } of patterns) {
    const match = expression.exec(userAgent);
    if (!match) continue;
    if (replacement !== undefined) {
      return {
        type,
        model: replacement.includes('$')
          ? replacement.replace(/\$(\d)/g, (_, index: string) => match[Number(index)] ?? '').trim()
          : replacement,
      };
    }
    if (match[1] !== undefined) return { type, model: match[1] };
  }
  return { type, model: 'Other' };
}

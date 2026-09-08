'use strict';

export const LOCAL_PROXY_SERVICES = Object.freeze({
  tor: Object.freeze({
    label: 'Локальный Tor',
    modKey: 'ifUseLocalTor',
    proxies: Object.freeze([
      'SOCKS5 localhost:9150',
      'SOCKS5 localhost:9050',
    ]),
  }),
  warp: Object.freeze({
    label: 'Локальный Cloudflare WARP',
    modKey: 'ifUseLocalWarp',
    proxies: Object.freeze([
      'SOCKS5 localhost:40000',
      'HTTPS localhost:40000',
    ]),
  }),
});

export function getLocalProxyService(serviceKey) {
  const ifKnownService = typeof serviceKey === 'string' &&
    Object.prototype.hasOwnProperty.call(LOCAL_PROXY_SERVICES, serviceKey);
  const service = ifKnownService ? LOCAL_PROXY_SERVICES[serviceKey] : null;
  if (!service) {
    throw new TypeError('Неизвестная локальная прокси-служба');
  }
  return service;
}

export async function checkLocalProxyService(serviceKey, checker) {
  const service = getLocalProxyService(serviceKey);
  if (typeof checker !== 'function') {
    throw new TypeError('Не задан обработчик проверки прокси');
  }

  const attempts = [];
  for (const proxy of service.proxies) {
    const result = await checker(proxy);
    attempts.push({
      proxy,
      ok: Boolean(result && result.ok),
      latency: result && result.latency,
      error: result && result.error,
    });
    if (result && result.ok) {
      return {
        ok: true,
        service: serviceKey,
        label: service.label,
        workingProxy: proxy,
        latency: result.latency,
        attempts,
      };
    }
  }

  return {
    ok: false,
    service: serviceKey,
    label: service.label,
    workingProxy: null,
    attempts,
    error: `${service.label} не обнаружен. Запустите службу и повторите попытку.`,
  };
}

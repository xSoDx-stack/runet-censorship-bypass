'use strict';

/**
 * Passive block informer (No active webRequest interceptors)
 */
class BlockInformer {
  constructor() {
    this.tabProxiedHosts = new Map();
  }

  init() {
    // Passive mode: zero intercepting of user browsing requests
  }

  handleProxiedRequest() {
    // No-op
  }
}

export const blockInformer = new BlockInformer();

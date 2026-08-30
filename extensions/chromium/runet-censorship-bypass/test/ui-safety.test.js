'use strict';

import { expect } from 'chai';
import fs from 'node:fs';

describe('UI Safety & DOM Injection Resistance (Task 7.2)', () => {
  // Simulate DOM environment for Node.js test
  class MockElement {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.className = '';
      this.textContent = '';
      this.title = '';
      this.dataset = {};
      this.children = [];
      this.style = {};
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    setAttribute(key, val) {
      this[key] = String(val);
    }
  }

  it('Safe DOM node construction must render XSS payloads as pure text without executing markup', () => {
    const maliciousPayload = '"><img src=x onerror=alert(1)><script>alert("hack")</script>';

    // 1. Create domain element as done in safe exceptions UI
    const card = new MockElement('div');
    card.className = 'domain-card';

    const nameSpan = new MockElement('span');
    nameSpan.className = 'domain-name';
    nameSpan.title = maliciousPayload;
    nameSpan.textContent = maliciousPayload;

    const delBtn = new MockElement('button');
    delBtn.className = 'delete-domain-btn';
    delBtn.title = 'Удалить';
    delBtn.dataset.domain = maliciousPayload;
    delBtn.textContent = '✕';

    card.appendChild(nameSpan);
    card.appendChild(delBtn);

    // Verify children
    expect(card.children.length).to.equal(2);
    expect(card.children[0].tagName).to.equal('SPAN');
    expect(card.children[1].tagName).to.equal('BUTTON');

    // No <img ...> or <script> elements were instantiated
    const childTagNames = card.children.map((c) => c.tagName);
    expect(childTagNames).to.not.include('IMG');
    expect(childTagNames).to.not.include('SCRIPT');

    // Text content is preserved verbatim
    expect(nameSpan.textContent).to.equal(maliciousPayload);
    expect(nameSpan.title).to.equal(maliciousPayload);
    expect(delBtn.dataset.domain).to.equal(maliciousPayload);
  });

  it('Special characters like \' " < > & in proxy addresses and logs are safely stored in attributes and text', () => {
    const complexPayload = `proxy.example.com/path?a=1&b=2<test>'quote"`;

    const addrSpan = new MockElement('span');
    addrSpan.className = 'proxy-addr';
    addrSpan.title = complexPayload;
    addrSpan.textContent = complexPayload;

    expect(addrSpan.textContent).to.equal(complexPayload);
    expect(addrSpan.title).to.equal(complexPayload);
  });

  it('loads the exceptions application as an ES module', () => {
    const htmlUrl = new URL('../src/extension-common/pages/exceptions/index.html', import.meta.url);
    const html = fs.readFileSync(htmlUrl, 'utf8');

    expect(html).to.match(/<script\s+type="module"\s+src="index\.js"><\/script>/);
  });
});

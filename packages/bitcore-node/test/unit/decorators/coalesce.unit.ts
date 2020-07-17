import { expect } from 'chai';

import { CoalesceClass } from '../../../src/decorators/Coalesce';
import { wait } from '../../../src/utils/wait';

@CoalesceClass
class TestClass {
  num = 1;
  async doResolve() {
    await wait(100);
    return Math.random();
  }

  async add(num1, num2) {
    await wait(100);
    return num1 + num2;
  }

  async multiply(num1, num2) {
    await wait(100);
    return num1 * num2;
  }

  async doThrow() {
    await wait(100);
    throw new Error('This should throw');
  }

  synchronous() {
    return 'testing';
  }
}

describe('CoalesceClass', function() {
  it('should return the same number', async () => {
    const test = new TestClass();
    const values = await Promise.all(new Array(5).fill(0).map(() => test.doResolve()));
    const first = values[0];
    values.forEach(val => expect(val).to.eq(first));
  });

  it('should all throw', async () => {
    const test = new TestClass();
    const values = new Array(5).fill(0).map(() => test.doThrow());
    for (const promise of values) {
      let didThrow = false;
      try {
        await promise;
      } catch (e) {
        didThrow = true;
      }
      expect(didThrow).to.eq(true);
    }
  });

  it('should return two different values', async () => {
    const test = new TestClass();
    const add = await test.add(3, 2);
    const mult = await test.multiply(3, 2);
    expect(add).to.eq(5);
    expect(mult).to.eq(6);
  });

  it('should not crash for synchronous functions', () => {
    const test = new TestClass();
    const str = test.synchronous();
    expect(str).to.eq('testing');
  });
});

import { hashOrderRequest, normalizeLines } from './order-lines';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('normalizeLines', () => {
  it('merges duplicate products and sorts by product id', () => {
    expect(
      normalizeLines([
        { productId: B, quantity: 1 },
        { productId: A, quantity: 2 },
        { productId: B, quantity: 5 },
      ]),
    ).toEqual([
      { productId: A, quantity: 2 },
      { productId: B, quantity: 6 },
    ]);
  });
});

describe('hashOrderRequest', () => {
  const base = { customerId: 'c1', paymentToken: 'tok_visa' };

  it('is stable across item order and line splitting', () => {
    const first = hashOrderRequest({
      ...base,
      items: [
        { productId: A, quantity: 2 },
        { productId: B, quantity: 1 },
      ],
    });
    const second = hashOrderRequest({
      ...base,
      items: [
        { productId: B, quantity: 1 },
        { productId: A, quantity: 1 },
        { productId: A, quantity: 1 },
      ],
    });
    expect(second).toBe(first);
  });

  it('changes when the order changes', () => {
    const one = hashOrderRequest({ ...base, items: [{ productId: A, quantity: 1 }] });
    const two = hashOrderRequest({ ...base, items: [{ productId: A, quantity: 2 }] });
    const otherCustomer = hashOrderRequest({
      ...base,
      customerId: 'c2',
      items: [{ productId: A, quantity: 1 }],
    });
    expect(new Set([one, two, otherCustomer]).size).toBe(3);
  });
});

import { ValidationPipe } from '@nestjs/common';
import { ListMedicinesDto } from '../../modules/products/pharmacy/medicines/dto/list-medicines.dto';
import { ListSuppliersDto } from '../../modules/products/pharmacy/suppliers/dto/list-suppliers.dto';

/**
 * Query strings are text at the edge. Without coercion `?limit=100` fails
 * `@IsInt`/`@Min`/`@Max` at once, which is what the suppliers list reported.
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true });

function asQuery<T>(metatype: new () => T, value: Record<string, string>) {
  return pipe.transform(value, { type: 'query', metatype });
}

describe('list query parameters', () => {
  it('coerces supplier paging and the active flag', async () => {
    await expect(asQuery(ListSuppliersDto, { limit: '100', offset: '20', active: 'true' })).resolves.toEqual({
      limit: 100,
      offset: 20,
      active: true,
    });
  });

  it('coerces medicine paging and the active flag', async () => {
    await expect(asQuery(ListMedicinesDto, { q: 'para', limit: '100', active: 'false' })).resolves.toEqual({
      q: 'para',
      limit: 100,
      active: false,
    });
  });

  it('still rejects values outside the allowed range', async () => {
    await expect(asQuery(ListSuppliersDto, { limit: '101' })).rejects.toThrow();
    await expect(asQuery(ListSuppliersDto, { limit: '0' })).rejects.toThrow();
    await expect(asQuery(ListSuppliersDto, { active: 'yes' })).rejects.toThrow();
  });

  it('leaves an omitted limit undefined so the service default applies', async () => {
    await expect(asQuery(ListSuppliersDto, {})).resolves.toEqual({});
  });
});

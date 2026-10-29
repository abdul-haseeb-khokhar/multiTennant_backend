import {
  createPrismaMock,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { ApiException } from '../common/errors/api.exception';
import {
  E164_PATTERN,
  PhoneCustomersService,
  phoneExternalId,
  phoneOfExternalId,
} from './phone-customers.service';

const PHONE = '+923001234567';

describe('phone helpers', () => {
  it('the external id of a caller is phone_<E.164> and can be read back', () => {
    expect(phoneExternalId(PHONE)).toBe('phone_+923001234567');
    expect(phoneOfExternalId('phone_+923001234567')).toBe(PHONE);
  });

  it('only a real number comes back as a phone; a widget visitor or garbage does not', () => {
    expect(phoneOfExternalId('web_abcdef0123456789')).toBeNull();
    expect(phoneOfExternalId('phone_hello')).toBeNull();
    expect(phoneOfExternalId('customer-17')).toBeNull();
  });

  it.each(['+923001234567', '+14155550123', '+442071838750'])(
    'accepts %s',
    (value) => expect(E164_PATTERN.test(value)).toBe(true),
  );
  it.each([
    '923001234567',
    '+0123456789',
    '+12',
    '+1234567890123456',
    '+92 300',
    '',
  ])('refuses %p', (value) => expect(E164_PATTERN.test(value)).toBe(false));
});

describe('PhoneCustomersService', () => {
  let prisma: PrismaMock;
  let service: PhoneCustomersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.endCustomer.updateMany.mockResolvedValue({ count: 1 });
    service = new PhoneCustomersService(prisma as never);
  });

  it('finds the customer by tenant AND external id and creates it when it is not there', async () => {
    prisma.endCustomer.findFirst.mockResolvedValue(null);
    prisma.endCustomer.create.mockResolvedValue({ id: 'ec1' });
    await expect(
      service.upsert('t1', { phone: PHONE, name: 'Ahmed', locale: 'ur' }),
    ).resolves.toEqual({ endCustomerId: 'ec1', created: true });
    expect(prisma.endCustomer.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 't1', externalId: 'phone_+923001234567' },
      select: { id: true },
    });
    expect(prisma.endCustomer.create).toHaveBeenCalledWith({
      data: {
        tenantId: 't1',
        externalId: 'phone_+923001234567',
        name: 'Ahmed',
        locale: 'ur',
      },
      select: { id: true },
    });
  });

  it('returns the existing customer and only fills the name and the language where they are empty', async () => {
    prisma.endCustomer.findFirst.mockResolvedValue({ id: 'ec1' });
    await expect(
      service.upsert('t1', { phone: PHONE, name: 'Ahmed', locale: 'ur' }),
    ).resolves.toEqual({ endCustomerId: 'ec1', created: false });
    expect(prisma.endCustomer.create).not.toHaveBeenCalled();
    expect(prisma.endCustomer.updateMany).toHaveBeenCalledWith({
      where: { id: 'ec1', tenantId: 't1', name: null },
      data: { name: 'Ahmed' },
    });
    expect(prisma.endCustomer.updateMany).toHaveBeenCalledWith({
      where: { id: 'ec1', tenantId: 't1', locale: null },
      data: { locale: 'ur' },
    });
  });

  it('writes nothing when there is nothing to fill in', async () => {
    prisma.endCustomer.findFirst.mockResolvedValue({ id: 'ec1' });
    await service.upsert('t1', { phone: PHONE });
    expect(prisma.endCustomer.updateMany).not.toHaveBeenCalled();
  });

  it('a parallel call for the same number: the loser of the unique index gets the winner', async () => {
    prisma.endCustomer.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'winner' });
    prisma.endCustomer.create.mockRejectedValue(prismaError('P2002'));
    await expect(service.upsert('t1', { phone: PHONE })).resolves.toEqual({
      endCustomerId: 'winner',
      created: false,
    });
  });

  it('lets other database errors through', async () => {
    prisma.endCustomer.findFirst.mockResolvedValue(null);
    prisma.endCustomer.create.mockRejectedValue(new Error('boom'));
    await expect(service.upsert('t1', { phone: PHONE })).rejects.toThrow(
      'boom',
    );
  });

  describe("upsertForCall (what the engine's route does)", () => {
    it("refuses an unknown tenant and an agent that is not the tenant's", async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(
        service.upsertForCall('nope', { phone: PHONE }),
      ).rejects.toMatchObject({ response: { code: 'TENANT_NOT_FOUND' } });
      prisma.tenant.findUnique.mockResolvedValue({ id: 't1' });
      prisma.agent.findFirst.mockResolvedValue(null);
      const error = await service
        .upsertForCall('t1', { phone: PHONE, agentId: 'ag-b' })
        .catch((e) => e);
      expect(error).toBeInstanceOf(ApiException);
      expect(error.response.code).toBe('AGENT_NOT_FOUND');
      expect(prisma.agent.findFirst).toHaveBeenCalledWith({
        where: { id: 'ag-b', tenantId: 't1' },
        select: { id: true },
      });
      expect(prisma.endCustomer.create).not.toHaveBeenCalled();
    });
  });
});

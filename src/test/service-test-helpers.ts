export function createRepositoryMock() {
  const findOneMock = jest.fn();
  return {
    findOne: findOneMock,
    findAndCount: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn((data: unknown) => data),
    remove: jest.fn(),
    softRemove: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(() => {
      const qb = createQueryBuilderMock();
      qb.getOne.mockImplementation(() => findOneMock() as Promise<unknown>);
      return qb;
    }),
    merge: jest.fn(),
  };
}

export function createMapperMock() {
  return {
    map: jest.fn((entity: unknown) => entity),
    mapArray: jest.fn((arr: unknown[]) => arr),
  };
}

export function createQueryBuilderMock(returnData: unknown[] = []) {
  const qb = {
    andWhere: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest
      .fn()
      .mockResolvedValue([returnData, returnData.length]),
    getMany: jest.fn().mockResolvedValue(returnData),
    getOne: jest.fn().mockResolvedValue(returnData[0] ?? null),
    getRawAndEntities: jest.fn().mockResolvedValue({
      entities: returnData,
      raw: returnData.map(() => ({})),
    }),
    getCount: jest.fn().mockResolvedValue(returnData.length),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
  };
  return qb;
}

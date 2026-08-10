export function createRepositoryMock() {
  return {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    create: jest.fn((data) => data),
    remove: jest.fn(),
    softRemove: jest.fn(),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(),
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

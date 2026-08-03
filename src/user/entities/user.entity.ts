import {
  Column,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  ManyToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Site } from '../../site/entities/site.entity';
import { UserRole } from '../enums/user-role.enum';
import { AutoMap } from '@automapper/classes';
import { Organization } from '../../organization/entities/organization.entity';

export enum UserGender {
  MALE = 'male',
  FEMALE = 'female',
  OTHER = 'other',
}

@Entity('users')
export class User {
  @AutoMap()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @AutoMap()
  @Column({ unique: true })
  email: string;

  @Column()
  password: string;

  @AutoMap()
  @Column()
  name: string;

  @AutoMap(() => String)
  @Column({ type: 'enum', enum: UserGender, nullable: true })
  gender: UserGender | null;

  @AutoMap(() => String)
  @Column({ type: 'date', nullable: true })
  dateOfBirth: string | null;

  @AutoMap(() => String)
  @Column({ type: 'varchar', nullable: true })
  phone: string | null;

  @AutoMap(() => String)
  @Column({ type: 'varchar', nullable: true })
  avatarUrl: string | null;

  @AutoMap()
  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.AGENT,
  })
  role: UserRole;

  @AutoMap()
  @Column({ default: false })
  twoFactorEnabled: boolean;

  @Column({ type: 'varchar', nullable: true })
  twoFactorSecret: string | null;

  @Column({ type: 'varchar', nullable: true })
  refreshToken: string | null;

  @DeleteDateColumn({ type: 'timestamp', nullable: true })
  deletedAt: Date | null;

  @AutoMap(() => String)
  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => Organization, (org) => org.users, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;
  @OneToMany(() => Site, (site) => site.owner)
  sites: Site[];

  @ManyToMany(() => Site, (site) => site.agents)
  assignedSites: Site[];
}

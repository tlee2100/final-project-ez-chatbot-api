import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AutoMap } from '@automapper/classes';
import { User } from '../../user/entities/user.entity';
import { Site } from '../../site/entities/site.entity';
import { ApiProperty } from '@nestjs/swagger';

@Entity('organizations')
export class Organization {
  @AutoMap()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @AutoMap()
  @Column()
  name: string;

  @AutoMap()
  @Column({ unique: true })
  slug: string;

  @AutoMap()
  @CreateDateColumn()
  createdAt: Date;

  @AutoMap()
  @UpdateDateColumn()
  updatedAt: Date;

  @AutoMap(() => String)
  @ApiProperty({
    description: 'The user ID of the organization owner',
    nullable: true,
  })
  @Column({ type: 'uuid', nullable: true })
  ownerId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'ownerId' })
  owner: User | null;

  @OneToMany(() => User, (user) => user.organization)
  users: User[];

  @OneToMany(() => Site, (site) => site.organization)
  sites: Site[];

  @AutoMap()
  @Column({ type: 'varchar', default: 'Active' })
  status: string;

  @AutoMap()
  @ApiProperty({
    description: 'Internal notes about this tenant',
    nullable: true,
  })
  @Column({ type: 'text', nullable: true })
  notes: string;
}

import neo4j, {
  Driver,
  Session,
  type Record as Neo4jRecord,
} from "neo4j-driver";
import type { Config } from "../config.js";

export class MemgraphClient {
  private driver: Driver;

  constructor(config: Config["memgraph"]) {
    this.driver = neo4j.driver(
      config.uri,
      config.user && config.password
        ? neo4j.auth.basic(config.user, config.password)
        : undefined,
    );
  }

  /** Execute a read-only Cypher query and return rows as plain objects. */
  async query(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> {
    const session: Session = this.driver.session({
      defaultAccessMode: neo4j.session.READ,
    });
    try {
      const result = await session.run(cypher, params);
      return result.records.map(
        (record: Neo4jRecord) => record.toObject() as Record<string, unknown>,
      );
    } finally {
      await session.close();
    }
  }

  /** Execute a write Cypher query (CREATE, MERGE, SET, DELETE). */
  async write(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> {
    const session: Session = this.driver.session({
      defaultAccessMode: neo4j.session.WRITE,
    });
    try {
      const result = await session.run(cypher, params);
      return result.records.map(
        (record: Neo4jRecord) => record.toObject() as Record<string, unknown>,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Given a function or file name, return every node that depends on it
   * (direct + transitive up to `maxDepth` hops).
   * Optionally filter edges by minimum confidence score.
   */
  async getImpact(
    name: string,
    maxDepth = 3,
    minConfidence = 0.0,
  ): Promise<Record<string, unknown>[]> {
    const cypher = `
      MATCH path = (source)-[:DEPENDS_ON|CALLS|IMPORTS*1..${maxDepth}]->(target)
      WHERE (source.name = $name OR source.file = $name)
        AND ALL(r IN relationships(path) WHERE coalesce(r.confidence, 1.0) >= $minConf)
      RETURN
        source.name  AS source,
        source.file  AS sourceFile,
        target.name  AS dependency,
        target.file  AS depFile,
        length(path)  AS depth
      ORDER BY depth
    `;
    return this.query(cypher, { name, minConf: minConfidence });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

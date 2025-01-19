// database.js:

"use strict";

const Sqlite = require("libsql");
const sql = require("./sql.js");

/**
 * A high-level SQLite database wrapper using libsql.
 */
class Database {
  #db = null;
  #logging = false;

  static toSqliteParams(params) {
    const convertedParams = {};
    for (const key in params) {
      let value = params[key];
      if (typeof value === "boolean")
        value = value ? 1 : 0; // Convert boolean to integer
      else if (value instanceof Date) value = value.toISOString(); // Convert Date to UTC string
      convertedParams[key] = value; // Keep the original key case
    }
    return convertedParams;
  }

  static toSQLiteValues(values) {
    const convertedValues = {};
    for (const key in values) {
      let value = values[key];
      if (typeof value === "boolean") value = value ? 1 : 0;
      else if (value instanceof Date) value = value.toISOString();
      convertedValues[key.toUpperCase()] = value;
    }
    return convertedValues;
  }

  static fromSQLiteValues(values, columns) {
    const convertedValues = {};
    for (const key in values) {
      let value = values[key];
      const column = columns.find(
        (col) => col.name.toUpperCase() === key.toUpperCase()
      );
      if (column) {
        if (column.type === "BOOLEAN") value = !!value;
        else if (column.type === "TIMESTAMP" && value !== null)
          value = new Date(value);
      }
      convertedValues[key] = value;
    }
    return convertedValues;
  }

  static filterValues(columns, values) {
    const filteredValues = {};
    columns.forEach((column) => {
      const columnName = column.name.toUpperCase();
      for (const key in values) {
        if (key.toUpperCase() === columnName) {
          filteredValues[columnName] = values[key];
        }
      }
    });
    return filteredValues;
  }

  static columnCase(columns, values) {
    const columnMap = columns.reduce((map, column) => {
      map[column.name.toUpperCase()] = column.name;
      return map;
    }, {});
    return Object.keys(values).reduce((adjustedValues, key) => {
      const originalKey = columnMap[key.toUpperCase()];
      if (originalKey) adjustedValues[originalKey] = values[key];
      return adjustedValues;
    }, {});
  }

  #checkConnected(operation) {
    if (!this.#db)
      throw new Error(`Database not connected during "${operation}"`);
  }

  #colExists(columns, name) {
    return columns.some((col) => col.name.toUpperCase() === name);
  }

  #log(method, statement, params) {
    if (this.#logging) {
      console.info("method", method);
      console.info(statement);
      console.info("params", params);
      console.info();
    }
  }

  connect({ filename, cipher, key }) {
    try {
      this.#db = new Sqlite(filename, { cipher, key });
    } catch (err) {
      throw new Error(`database.connect: ${err.message}`);
    }
  }

  disconnect() {
    this.#db = null;
  }

  get connected() {
    return !!this.#db;
  }

  get logging() {
    return this.#logging;
  }

  set logging(value) {
    this.#logging = value;
  }

  createTable(table, columns) {
    this.#checkConnected("createTable");
    const statements = sql.createTable(table.toUpperCase(), columns);
    this.#log("createTable", statements, {});
    statements.forEach((statement) => this.#db.prepare(statement).run());
    return true;
  }

  dropTable(table) {
    this.#checkConnected("dropTable");
    const statement = sql.dropTable(table);
    this.#log("DROP TABLE", statement, {});
    this.#db.prepare(statement).run();
    return true;
  }

  insert(table, columns, values, options = {}) {
    this.#checkConnected("insert");
    try {
      // call before insert hook if one exists
      if (options.beforeInsert) options.beforeInsert(values);

      const filtered = Database.filterValues(columns, values);
      let newValues = Database.toSQLiteValues(filtered);

      if (this.#colExists(columns, "CREATED_AT") && !newValues.CREATED_AT) {
        newValues.CREATED_AT = new Date().toISOString();
      }

      // create the sql statement string
      const statement = sql.insert(table, newValues);
      this.#log("INSERT", statement, newValues);

      // perform actual sql insert command
      const results = this.#db.prepare(statement).run(newValues);

      // if one row was not changed then we were not successful
      if (results.changes !== 1) {
        throw new Error(`Insert into "${table}" failed`);
      }

      // reread the new record from the database
      const resultStatement = sql.findById(table, results.lastInsertRowid);
      let insertedRow = this.#db.prepare(resultStatement).get();

      // convert column names in row to case defined in column definitions
      insertedRow = Database.columnCase(
        columns,
        Database.fromSQLiteValues(insertedRow, columns)
      );

      // if there is an after insert hook then call it
      if (options.afterInsert) options.afterInsert(insertedRow);
      return insertedRow;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  update(table, columns, values, options = {}) {
    this.#checkConnected("update");
    try {
      // call before update hook if one exists
      if (options.beforeUpdate) options.beforeUpdate(values);

      const filtered = Database.filterValues(columns, values);
      let newValues = Database.toSQLiteValues(filtered);

      if (this.#colExists(columns, "UPDATED_AT") && !newValues.UPDATED_AT) {
        newValues.UPDATED_AT = new Date().toISOString();
      }

      // create the sql statement string
      const statement = sql.update(table, newValues);
      this.#log("update", statement, newValues);

      // perform actual sql update command
      const results = this.#db.prepare(statement).run(newValues);

      // if one row was not changed then we were not successful
      if (results.changes !== 1) {
        throw new Error(`Update of "${table}" failed`);
      }

      // reread the new record from the database, "lastInsertedRowId" is special better-sqlite3 value
      const resultStatement = sql.findById(table, results.lastInsertRowid);
      let updatedRow = this.#db.prepare(resultStatement).get();

      // convert column names in row to case defined in column definitions
      updatedRow = Database.columnCase(
        columns,
        Database.fromSQLiteValues(updatedRow, columns)
      );

      // if there is an after update hook then call it
      if (options.afterUpdate) options.afterUpdate(updatedRow);

      // return the updated row values
      return updatedRow;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  delete(table, id, options = {}) {
    this.#checkConnected("delete");
    if (options.beforeDelete) options.beforeDelete(id);

    const statement = sql.delete(table);
    const params = { ID: id };
    this.#log("DELETE", statement, params);
    const results = this.#db.prepare(statement).run(params);

    const ok = results.changes === 1;
    if (options.afterDelete) options.afterDelete({ ok });
    return ok;
  }

  findById(table, columns, id, options = {}) {
    return this.findByColumn(table, columns, "id", id, options);
  }

  findByColumn(table, columns, name, value, options = {}) {
    return this.findOne(
      table,
      columns,
      `${name} = :${name}`,
      { [name]: value },
      options
    );
  }

  findOne(table, columns, criteria = "", params = {}, options = {}) {
    options.limit = 1;
    const results = this.findMany(table, columns, criteria, params, options);
    return results.length > 0 ? results[0] : null;
  }

  findMany(table, columns, criteria = "", params = {}, options = {}) {
    this.#checkConnected("findMany");
    let statement = `SELECT * FROM ${table.toUpperCase()}`;
    if (criteria.trim()) statement += ` WHERE ${criteria}`;
    if (options.limit) statement += ` LIMIT ${options.limit}`;
    if (options.offset) statement += ` OFFSET ${options.offset}`;

    this.#log("FINDMANY", statement, { params, options });
    const results = this.#db
      .prepare(statement)
      .all(Database.toSqliteParams(params));
    const list = results.map((row) =>
      Database.columnCase(columns, Database.fromSQLiteValues(row, columns))
    );
    //    console.log("list", list);
    return list;
  }

  execute(statement, params = {}) {
    this.#checkConnected("execute");
    this.#log("EXECUTE", statement, params);
    return this.#db.prepare(statement).run(this.toSqliteParams(params)).changes;
  }

  query(statement, params = {}, options = {}, columns = []) {
    this.#checkConnected("query");
    if (options.limit) statement += ` LIMIT ${options.limit}`;
    if (options.offset) statement += ` OFFSET ${options.offset}`;

    this.#log("QUERY", statement, params);
    const results = this.#db.prepare(statement).all(params);
    return results.map((row) =>
      Database.columnCase(columns, Database.fromSQLiteValues(row, columns))
    );
  }
}

module.exports = Database;
